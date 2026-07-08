import { beforeEach, describe, expect, it, vi } from "vitest";

// TRE-932 — service-level tests for the native `interview` interaction kind.

vi.mock("./issues.js", () => ({
  issueService: () => ({ createChild: vi.fn() }),
  runWorkspaceIsFinalized: vi.fn(async () => true),
}));

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: () => null,
}));

const ISSUE = { id: "11111111-1111-4111-8111-111111111111", companyId: "company-1" };
const BOARD = { userId: "local-board" } as const;
const AGENT = { agentId: "agent-1" } as const;

type Row = Record<string, unknown>;

// A minimal drizzle-shaped fake db backed by a single mutable interaction row.
// Mutation happens in `.returning()` so `touchIssue` (no returning) is a no-op.
function makeDb(initialRow: Row) {
  let row: Row = { ...initialRow };
  const db: any = {
    select: () => ({
      from: () => ({
        where: () => ({
          then: (cb: (rows: Row[]) => unknown) => Promise.resolve(cb([row])),
        }),
      }),
    }),
    insert: () => ({
      values: (values: Row) => ({
        returning: async () => {
          row = { ...values, id: row.id ?? "interaction-1", createdAt: new Date(), updatedAt: new Date() };
          return [row];
        },
      }),
    }),
    update: () => ({
      set: (values: Row) => ({
        where: () => ({
          returning: async () => {
            row = { ...row, ...values };
            return [row];
          },
        }),
      }),
    }),
  };
  return { db, get: () => row };
}

function interviewRow(overrides: Row = {}): Row {
  return {
    id: "interaction-1",
    companyId: ISSUE.companyId,
    issueId: ISSUE.id,
    kind: "interview",
    status: "pending",
    continuationPolicy: "wake_assignee",
    idempotencyKey: null,
    sourceCommentId: null,
    sourceRunId: null,
    title: null,
    summary: null,
    createdByAgentId: "agent-1",
    createdByUserId: null,
    resolvedByAgentId: null,
    resolvedByUserId: null,
    payload: {
      version: 1,
      topic: "Planning",
      phase: "awaiting_answer",
      supersedeOnUserComment: false,
      turns: [
        { id: "turn-1", question: "What is the goal?", answer: null, askedAt: "2026-07-08T10:00:00.000Z", answeredAt: null },
      ],
    },
    result: null,
    resolvedAt: null,
    createdAt: new Date("2026-07-08T10:00:00.000Z"),
    updatedAt: new Date("2026-07-08T10:00:00.000Z"),
    ...overrides,
  };
}

async function loadService(row: Row) {
  const { issueThreadInteractionService } = await import("./issue-thread-interactions.js");
  const { db, get } = makeDb(row);
  return { svc: issueThreadInteractionService(db as never), get };
}

describe("interview interaction — service state machine", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("opens an interview with a synthesized first turn", async () => {
    const { svc } = await loadService(interviewRow());
    const created = await svc.create(ISSUE, {
      kind: "interview",
      continuationPolicy: "wake_assignee",
      payload: { version: 1, topic: "Scope", question: "What is the scope?" },
    } as never, AGENT);

    expect(created.kind).toBe("interview");
    if (created.kind !== "interview") throw new Error("unreachable");
    expect(created.status).toBe("pending");
    expect(created.payload.phase).toBe("awaiting_answer");
    expect(created.payload.turns).toHaveLength(1);
    expect(created.payload.turns[0]!.question).toBe("What is the scope?");
    expect(created.payload.turns[0]!.answer).toBeNull();
    expect(typeof created.payload.turns[0]!.id).toBe("string");
    expect(created.payload.supersedeOnUserComment).toBe(false);
  });

  it("runs a full multi-turn round-trip: answer -> ask -> answer -> complete", async () => {
    const { svc, get } = await loadService(interviewRow());

    // Board answers the first question via /respond.
    let interaction = await svc.answerQuestions(ISSUE, "interaction-1", { answer: "Ship v1" }, BOARD);
    expect(interaction.kind).toBe("interview");
    if (interaction.kind !== "interview") throw new Error("unreachable");
    expect(interaction.status).toBe("pending");
    expect(interaction.payload.phase).toBe("awaiting_next_question");
    expect(interaction.payload.turns[0]!.answer).toBe("Ship v1");
    expect(interaction.payload.turns[0]!.answeredAt).toBeTruthy();

    // Agent appends the next question via /advance.
    interaction = await svc.advanceInterview(ISSUE, "interaction-1", { action: "ask", question: "By when?" }, AGENT) as typeof interaction;
    if (interaction.kind !== "interview") throw new Error("unreachable");
    expect(interaction.payload.phase).toBe("awaiting_answer");
    expect(interaction.payload.turns).toHaveLength(2);
    expect(interaction.payload.turns[1]!.question).toBe("By when?");

    // Board answers the second question.
    interaction = await svc.answerQuestions(ISSUE, "interaction-1", { answer: "End of Q3" }, BOARD) as typeof interaction;
    if (interaction.kind !== "interview") throw new Error("unreachable");
    expect(interaction.payload.phase).toBe("awaiting_next_question");
    expect(interaction.payload.turns[1]!.answer).toBe("End of Q3");

    // Agent completes the interview.
    interaction = await svc.advanceInterview(ISSUE, "interaction-1", { action: "complete", summaryMarkdown: "Ship v1 by Q3" }, AGENT) as typeof interaction;
    if (interaction.kind !== "interview") throw new Error("unreachable");
    expect(interaction.status).toBe("answered");
    expect(interaction.payload.phase).toBe("complete");
    expect(interaction.result?.outcome).toBe("complete");
    expect(interaction.result?.summaryMarkdown).toBe("Ship v1 by Q3");
    expect(interaction.result?.turns).toHaveLength(2);
    expect(get().resolvedAt).toBeInstanceOf(Date);
  });

  it("lets the agent abandon an interview", async () => {
    const { svc } = await loadService(interviewRow({ payload: {
      version: 1,
      topic: null,
      phase: "awaiting_next_question",
      supersedeOnUserComment: false,
      turns: [{ id: "turn-1", question: "Q1", answer: "A1", askedAt: "2026-07-08T10:00:00.000Z", answeredAt: "2026-07-08T10:05:00.000Z" }],
    } }));

    const interaction = await svc.advanceInterview(ISSUE, "interaction-1", { action: "abandon", reason: "No longer needed" }, AGENT);
    if (interaction.kind !== "interview") throw new Error("unreachable");
    expect(interaction.status).toBe("cancelled");
    expect(interaction.payload.phase).toBe("abandoned");
    expect(interaction.result?.outcome).toBe("abandoned");
    expect(interaction.result?.abandonedBy).toBe("agent");
    expect(interaction.result?.reason).toBe("No longer needed");
  });

  it("lets the board abandon an interview at any time via /cancel", async () => {
    const { svc } = await loadService(interviewRow());
    const interaction = await svc.cancelQuestions(ISSUE, "interaction-1", { reason: "Changed direction" }, BOARD);
    if (interaction.kind !== "interview") throw new Error("unreachable");
    expect(interaction.status).toBe("cancelled");
    expect(interaction.payload.phase).toBe("abandoned");
    expect(interaction.result?.abandonedBy).toBe("board");
  });

  it("rejects answering when the interview is not awaiting an answer", async () => {
    const { svc } = await loadService(interviewRow({ payload: {
      version: 1,
      topic: null,
      phase: "awaiting_next_question",
      supersedeOnUserComment: false,
      turns: [{ id: "turn-1", question: "Q1", answer: "A1", askedAt: "2026-07-08T10:00:00.000Z", answeredAt: "2026-07-08T10:05:00.000Z" }],
    } }));
    await expect(svc.answerQuestions(ISSUE, "interaction-1", { answer: "late" }, BOARD)).rejects.toThrow(/not awaiting an answer/i);
  });

  it("requires an `answer` when responding to an interview", async () => {
    const { svc } = await loadService(interviewRow());
    await expect(svc.answerQuestions(ISSUE, "interaction-1", {} as never, BOARD)).rejects.toThrow(/require an `answer`/i);
  });

  it("rejects asking the next question before the current one is answered", async () => {
    const { svc } = await loadService(interviewRow()); // phase awaiting_answer
    await expect(svc.advanceInterview(ISSUE, "interaction-1", { action: "ask", question: "Q2" }, AGENT))
      .rejects.toThrow(/not ready for the next question/i);
  });

  it("rejects advancing an already-resolved interview", async () => {
    const { svc } = await loadService(interviewRow({ status: "answered", payload: {
      version: 1,
      topic: null,
      phase: "complete",
      supersedeOnUserComment: false,
      turns: [{ id: "turn-1", question: "Q1", answer: "A1", askedAt: "2026-07-08T10:00:00.000Z", answeredAt: "2026-07-08T10:05:00.000Z" }],
    } }));
    await expect(svc.advanceInterview(ISSUE, "interaction-1", { action: "ask", question: "Q2" }, AGENT))
      .rejects.toThrow(/already been resolved/i);
  });

  it("rejects advancing a non-interview interaction", async () => {
    const { svc } = await loadService(interviewRow({ kind: "ask_user_questions", payload: {
      version: 1,
      questions: [{ id: "q", prompt: "P", selectionMode: "single", options: [{ id: "o", label: "O" }] }],
    } }));
    await expect(svc.advanceInterview(ISSUE, "interaction-1", { action: "abandon" }, AGENT))
      .rejects.toThrow(/Only interview interactions can be advanced/i);
  });

  it("keeps ask_user_questions answering working (backward-compat)", async () => {
    const { svc } = await loadService(interviewRow({ kind: "ask_user_questions", payload: {
      version: 1,
      questions: [{ id: "scope", prompt: "Scope?", selectionMode: "single", options: [{ id: "phase-1", label: "Phase 1" }] }],
    } }));
    const answered = await svc.answerQuestions(ISSUE, "interaction-1", {
      answers: [{ questionId: "scope", optionIds: ["phase-1"] }],
    }, BOARD);
    expect(answered.kind).toBe("ask_user_questions");
    expect(answered.status).toBe("answered");
  });
});
