import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  InterviewSession,
  buildOpenInterviewRequest,
  buildAskRequest,
  buildCompleteRequest,
  buildAbandonRequest,
  interpretInterview,
  isInterviewTerminal,
  type InterviewApi,
  type InterviewInteraction,
} from "@paperclipai/adapter-utils";

// TRE-933 — round-trip test for the planning-mode interview driver.
//
// The driver (adapter-utils/interview-driver) is exercised against the REAL
// `issueThreadInteractionService` state machine and the REAL zod route
// validators: `service.create` runs `createIssueThreadInteractionSchema.parse`
// and `service.advanceInterview` runs `advanceInterviewSchema.parse`, so the
// bodies the helper builds must satisfy the HTTP contract to get this far. The
// board's answers are applied via `service.answerQuestions` (the `/respond`
// path), simulating the wake_assignee resume cycle one question at a time.

vi.mock("./issues.js", () => ({
  issueService: () => ({ createChild: vi.fn() }),
  runWorkspaceIsFinalized: vi.fn(async () => true),
}));

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: () => null,
}));

const ISSUE = { id: "22222222-2222-4222-8222-222222222222", companyId: "company-1" };
const BOARD = { userId: "local-board" } as const;
const AGENT = { agentId: "agent-1" } as const;

type Row = Record<string, unknown>;

// A minimal drizzle-shaped fake db backed by a single mutable interaction row,
// matching the fixture used by issue-thread-interviews.test.ts.
function makeDb() {
  let row: Row | null = null;
  const db: any = {
    select: () => ({
      from: () => ({
        where: () => ({
          then: (cb: (rows: Row[]) => unknown) => Promise.resolve(cb(row ? [row] : [])),
          orderBy: () => Promise.resolve(row ? [row] : []),
        }),
      }),
    }),
    insert: () => ({
      values: (values: Row) => ({
        returning: async () => {
          row = { ...values, id: "interaction-1", createdAt: new Date(), updatedAt: new Date() };
          return [row];
        },
      }),
    }),
    update: () => ({
      set: (values: Row) => ({
        where: () => ({
          returning: async () => {
            row = { ...(row ?? {}), ...values };
            return [row];
          },
        }),
      }),
    }),
  };
  return db;
}

// Bind the helper's InterviewApi seam to the real service. In production this is
// createHttpInterviewApi() hitting the live routes; here it drives the service
// directly so the state machine + validators are the real thing.
async function makeApiAndBoard() {
  const { issueThreadInteractionService } = await import("./issue-thread-interactions.js");
  const svc = issueThreadInteractionService(makeDb() as never);

  const api: InterviewApi = {
    async open(body) {
      return (await svc.create(ISSUE, body as never, AGENT)) as unknown as InterviewInteraction;
    },
    async advance(interactionId, body) {
      return (await svc.advanceInterview(ISSUE, interactionId, body as never, AGENT)) as unknown as InterviewInteraction;
    },
    async get(interactionId) {
      const found = await svc.getById(interactionId);
      if (!found) throw new Error(`interaction ${interactionId} not found`);
      return found as unknown as InterviewInteraction;
    },
  };

  // The board answering the current open question via /respond.
  const boardAnswers = async (interactionId: string, answer: string) => {
    await svc.answerQuestions(ISSUE, interactionId, { answer } as never, BOARD);
  };

  return { api, boardAnswers };
}

describe("interview driver — round-trip against the real interview API", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("drives a full multi-turn interview one question at a time, resuming each wake", async () => {
    const { api, boardAnswers } = await makeApiAndBoard();

    // Planning-mode agent opens the interview with its first question.
    const session = await InterviewSession.open(api, {
      topic: "Scope",
      question: "What is the goal for v1?",
    });
    expect(session.interaction.kind).toBe("interview");

    // We asked; the board has not answered — the agent yields until the next wake.
    let step = session.step;
    expect(step.status).toBe("awaiting_answer");
    if (step.status !== "awaiting_answer") throw new Error("unreachable");
    expect(step.pendingQuestion).toBe("What is the goal for v1?");
    expect(step.answeredCount).toBe(0);
    expect(session.isTerminal).toBe(false);

    // --- wake 1: board answered the first question ---
    await boardAnswers(session.interactionId, "Ship the planning-mode helper");
    step = await session.refresh();
    expect(step.status).toBe("ready");
    if (step.status !== "ready") throw new Error("unreachable");
    expect(step.lastAnswer).toBe("Ship the planning-mode helper");
    expect(step.answeredTurns).toHaveLength(1);

    // Agent asks the next question.
    step = await session.ask("By when should it land?");
    expect(step.status).toBe("awaiting_answer");
    if (step.status !== "awaiting_answer") throw new Error("unreachable");
    expect(step.pendingQuestion).toBe("By when should it land?");
    expect(step.answeredCount).toBe(1);

    // --- wake 2: board answered the second question ---
    await boardAnswers(session.interactionId, "End of the week");
    step = await session.refresh();
    expect(step.status).toBe("ready");

    // Agent wraps up the interview.
    step = await session.complete("Ship the planning-mode helper by end of week.");
    expect(step.status).toBe("complete");
    if (step.status !== "complete") throw new Error("unreachable");
    expect(step.answeredTurns).toHaveLength(2);
    expect(session.isTerminal).toBe(true);
    expect(session.interaction.status).toBe("answered");
    expect(session.interaction.result?.outcome).toBe("complete");
    expect(session.interaction.result?.summaryMarkdown).toBe(
      "Ship the planning-mode helper by end of week.",
    );
  });

  it("lets the agent abandon an in-flight interview", async () => {
    const { api } = await makeApiAndBoard();
    const session = await InterviewSession.open(api, { question: "Still worth pursuing?" });

    const step = await session.abandon("Direction changed");
    expect(step.status).toBe("abandoned");
    expect(session.interaction.status).toBe("cancelled");
    expect(session.interaction.result?.outcome).toBe("abandoned");
    expect(session.interaction.result?.abandonedBy).toBe("agent");
    expect(session.interaction.result?.reason).toBe("Direction changed");
  });

  it("refuses to advance before the board has answered the open question", async () => {
    const { api } = await makeApiAndBoard();
    const session = await InterviewSession.open(api, { question: "First?" });

    // Local guard fires before any API call — phase is still awaiting_answer.
    await expect(session.ask("Second?")).rejects.toThrow(/awaiting_next_question/);
    await expect(session.complete()).rejects.toThrow(/awaiting_next_question/);
  });
});

describe("interview driver — pure helpers", () => {
  it("builds an open request with wake_assignee and a trimmed question", () => {
    const body = buildOpenInterviewRequest({ question: "  What now?  ", topic: "Plan" });
    expect(body).toEqual({
      kind: "interview",
      continuationPolicy: "wake_assignee",
      payload: { version: 1, question: "What now?", topic: "Plan" },
    });
  });

  it("rejects an empty open question", () => {
    expect(() => buildOpenInterviewRequest({ question: "   " })).toThrow(/non-empty/);
  });

  it("builds advance requests", () => {
    expect(buildAskRequest("  Next?  ")).toEqual({ action: "ask", question: "Next?" });
    expect(buildCompleteRequest("done")).toEqual({ action: "complete", summaryMarkdown: "done" });
    expect(buildCompleteRequest()).toEqual({ action: "complete" });
    expect(buildAbandonRequest("nope")).toEqual({ action: "abandon", reason: "nope" });
    expect(buildAbandonRequest()).toEqual({ action: "abandon" });
  });

  it("interprets each interview phase", () => {
    const base = {
      id: "i1",
      kind: "interview" as const,
      status: "pending",
    };
    const awaitingAnswer: InterviewInteraction = {
      ...base,
      payload: {
        version: 1,
        phase: "awaiting_answer",
        turns: [{ id: "t1", question: "Q1", answer: null, askedAt: "2026-07-08T10:00:00.000Z", answeredAt: null }],
      },
    };
    expect(interpretInterview(awaitingAnswer).status).toBe("awaiting_answer");
    expect(isInterviewTerminal(awaitingAnswer)).toBe(false);

    const ready: InterviewInteraction = {
      ...base,
      payload: {
        version: 1,
        phase: "awaiting_next_question",
        turns: [{ id: "t1", question: "Q1", answer: "A1", askedAt: "2026-07-08T10:00:00.000Z", answeredAt: "2026-07-08T10:05:00.000Z" }],
      },
    };
    const readyStep = interpretInterview(ready);
    expect(readyStep.status).toBe("ready");
    if (readyStep.status !== "ready") throw new Error("unreachable");
    expect(readyStep.lastAnswer).toBe("A1");

    const complete: InterviewInteraction = {
      ...base,
      status: "answered",
      payload: { version: 1, phase: "complete", turns: ready.payload.turns },
      result: { version: 1, outcome: "complete", turns: ready.payload.turns, summaryMarkdown: "done" },
    };
    expect(interpretInterview(complete).status).toBe("complete");
    expect(isInterviewTerminal(complete)).toBe(true);
  });
});
