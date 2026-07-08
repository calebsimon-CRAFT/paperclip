// TRE-933 — client-side helper for driving a native `interview` interaction
// (TRE-932) one question at a time.
//
// A planning-mode agent (and the plans-to-tasks flow) opens an interview to ask
// the board a question, then yields. The interview is created with
// `continuationPolicy: "wake_assignee"`, so when the board answers via
// `/respond` the assignee run is woken again. On each wake the agent re-reads the
// interview and decides what to do next: ask the next question, or wrap up. This
// mirrors the wrap-up interview at the end of epic TRE-910 — one question per
// turn, not a batched form.
//
// The module is transport-agnostic. The pure pieces (`interpretInterview` +
// request builders) carry the state logic; `InterviewApi` abstracts the HTTP so
// the same code drives the live interview routes in production and an in-process
// service in tests. Composes with the MEMORY.md recall shim landed in TRE-926 —
// the agent recalls prior context on wake, then interprets the interview here.

// ---------------------------------------------------------------------------
// Minimal structural types. Kept local so adapter-utils stays dependency-free
// (matching its current package.json); these mirror `@paperclipai/shared`'s
// InterviewPayload / InterviewTurn / InterviewResult / InterviewInteraction.
// ---------------------------------------------------------------------------

export type InterviewPhase =
  | "awaiting_answer"
  | "awaiting_next_question"
  | "complete"
  | "abandoned";

export interface InterviewTurn {
  id: string;
  question: string;
  answer?: string | null;
  askedAt: string;
  answeredAt?: string | null;
}

export interface InterviewPayload {
  version: 1;
  topic?: string | null;
  phase: InterviewPhase;
  turns: InterviewTurn[];
  supersedeOnUserComment?: boolean;
}

export interface InterviewResult {
  version: 1;
  outcome: "complete" | "abandoned";
  turns: InterviewTurn[];
  summaryMarkdown?: string | null;
  reason?: string | null;
  abandonedBy?: "agent" | "board" | null;
}

export interface InterviewInteraction {
  id: string;
  kind: "interview";
  status: string;
  payload: InterviewPayload;
  result?: InterviewResult | null;
}

// ---------------------------------------------------------------------------
// Request builders (pure). These produce the exact bodies the interview routes
// accept — POST /issues/:id/interactions (open) and POST
// /issues/:id/interactions/:interactionId/advance (ask / complete / abandon).
// ---------------------------------------------------------------------------

export interface OpenInterviewOptions {
  /** The first question to put to the board. */
  question: string;
  /** Optional short topic label shown in the thread. */
  topic?: string | null;
  /** Optional idempotency key so a retried open does not create a duplicate. */
  idempotencyKey?: string | null;
  /**
   * Whether a subsequent board comment should supersede (expire) the open
   * question. Defaults to false — an interview intentionally stays open across
   * board chatter until answered or abandoned.
   */
  supersedeOnUserComment?: boolean;
}

export interface OpenInterviewRequest {
  kind: "interview";
  continuationPolicy: "wake_assignee";
  idempotencyKey?: string | null;
  payload: {
    version: 1;
    topic?: string | null;
    question: string;
    supersedeOnUserComment?: boolean;
  };
}

export function buildOpenInterviewRequest(options: OpenInterviewOptions): OpenInterviewRequest {
  const question = options.question?.trim();
  if (!question) {
    throw new Error("buildOpenInterviewRequest: a non-empty `question` is required");
  }
  const request: OpenInterviewRequest = {
    kind: "interview",
    // wake_assignee is the only sensible policy: the board's answer must wake the
    // interviewing agent so it can ask the next question or wrap up.
    continuationPolicy: "wake_assignee",
    payload: {
      version: 1,
      question,
    },
  };
  if (options.topic != null) request.payload.topic = options.topic;
  if (options.supersedeOnUserComment != null) {
    request.payload.supersedeOnUserComment = options.supersedeOnUserComment;
  }
  if (options.idempotencyKey != null) request.idempotencyKey = options.idempotencyKey;
  return request;
}

export type AdvanceInterviewRequest =
  | { action: "ask"; question: string }
  | { action: "complete"; summaryMarkdown?: string | null }
  | { action: "abandon"; reason?: string | null };

export function buildAskRequest(question: string): AdvanceInterviewRequest {
  const trimmed = question?.trim();
  if (!trimmed) {
    throw new Error("buildAskRequest: a non-empty `question` is required");
  }
  return { action: "ask", question: trimmed };
}

export function buildCompleteRequest(summaryMarkdown?: string | null): AdvanceInterviewRequest {
  return summaryMarkdown != null
    ? { action: "complete", summaryMarkdown }
    : { action: "complete" };
}

export function buildAbandonRequest(reason?: string | null): AdvanceInterviewRequest {
  return reason != null ? { action: "abandon", reason } : { action: "abandon" };
}

// ---------------------------------------------------------------------------
// State interpreter (pure) — the "what do I do on this wake?" brain.
//
// Given the current interview interaction, tell the caller exactly what state it
// is in and hand back the context needed to act, so a resumed run never has to
// re-derive phase logic from raw turns.
// ---------------------------------------------------------------------------

export type InterviewStep =
  // We asked a question and the board has not answered it yet — yield and wait
  // for the next wake_assignee. `pendingQuestion`/`pendingTurnId` describe the
  // open turn.
  | { status: "awaiting_answer"; pendingQuestion: string; pendingTurnId: string; answeredCount: number }
  // The board answered the latest question. The agent should now either ask the
  // next question or complete the interview. `lastAnswer`/`lastQuestion` are the
  // just-answered turn; `answeredTurns` is the full answered history.
  | { status: "ready"; lastQuestion: string; lastAnswer: string; answeredTurns: InterviewTurn[] }
  // Terminal.
  | { status: "complete"; result: InterviewResult | null; answeredTurns: InterviewTurn[] }
  | { status: "abandoned"; result: InterviewResult | null; answeredTurns: InterviewTurn[] };

function answeredTurns(payload: InterviewPayload): InterviewTurn[] {
  return payload.turns.filter((t) => t.answer != null && t.answer !== "");
}

export function interpretInterview(interaction: InterviewInteraction): InterviewStep {
  if (interaction.kind !== "interview") {
    throw new Error(`interpretInterview: expected an interview interaction, got \`${interaction.kind}\``);
  }
  const payload = interaction.payload;
  const answered = answeredTurns(payload);

  switch (payload.phase) {
    case "awaiting_answer": {
      const pending = payload.turns[payload.turns.length - 1];
      if (!pending) {
        throw new Error("interpretInterview: interview is awaiting an answer but has no turns");
      }
      return {
        status: "awaiting_answer",
        pendingQuestion: pending.question,
        pendingTurnId: pending.id,
        answeredCount: answered.length,
      };
    }
    case "awaiting_next_question": {
      const last = answered[answered.length - 1];
      if (!last || last.answer == null) {
        throw new Error("interpretInterview: interview is awaiting the next question but has no answered turn");
      }
      return {
        status: "ready",
        lastQuestion: last.question,
        lastAnswer: last.answer,
        answeredTurns: answered,
      };
    }
    case "complete":
      return { status: "complete", result: interaction.result ?? null, answeredTurns: answered };
    case "abandoned":
      return { status: "abandoned", result: interaction.result ?? null, answeredTurns: answered };
    default: {
      const exhaustive: never = payload.phase;
      throw new Error(`interpretInterview: unknown phase \`${String(exhaustive)}\``);
    }
  }
}

/** True once the interview reached a terminal phase and cannot be advanced. */
export function isInterviewTerminal(interaction: InterviewInteraction): boolean {
  return interaction.payload.phase === "complete" || interaction.payload.phase === "abandoned";
}

// ---------------------------------------------------------------------------
// Transport + session. `InterviewApi` is the thin seam over the interview
// routes; `InterviewSession` is stateful sugar for a single wake.
// ---------------------------------------------------------------------------

export interface InterviewApi {
  /** POST /issues/:id/interactions — open a new interview. */
  open(body: OpenInterviewRequest): Promise<InterviewInteraction>;
  /** POST /issues/:id/interactions/:interactionId/advance — ask / complete / abandon. */
  advance(interactionId: string, body: AdvanceInterviewRequest): Promise<InterviewInteraction>;
  /** Re-read the current interview state (e.g. after a wake). */
  get(interactionId: string): Promise<InterviewInteraction>;
}

/** A `fetch`-compatible function (the global fetch, node-fetch, or a wrapper). */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> }>;

export interface HttpInterviewApiOptions {
  fetch: FetchLike;
  /** Base URL of the control plane, e.g. "http://127.0.0.1:3100". */
  baseUrl: string;
  /** The issue the interview lives on. */
  issueId: string;
  /** Extra headers (Authorization, X-Paperclip-Run-Id, …) sent on every call. */
  headers?: Record<string, string>;
}

/**
 * Build an `InterviewApi` bound to the live control-plane interview routes.
 * There is no GET-by-id route, so `get` lists the issue's interactions and finds
 * the one by id (mirroring how the thread UI hydrates interactions).
 */
export function createHttpInterviewApi(options: HttpInterviewApiOptions): InterviewApi {
  const { fetch: doFetch, issueId } = options;
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const headers = { "content-type": "application/json", ...(options.headers ?? {}) };
  const root = `${baseUrl}/api/issues/${encodeURIComponent(issueId)}/interactions`;

  async function readJson(res: Awaited<ReturnType<FetchLike>>, context: string): Promise<unknown> {
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`interview ${context} failed: ${res.status} ${detail}`.trim());
    }
    return res.json();
  }

  return {
    async open(body) {
      const res = await doFetch(root, { method: "POST", headers, body: JSON.stringify(body) });
      return (await readJson(res, "open")) as InterviewInteraction;
    },
    async advance(interactionId, body) {
      const url = `${root}/${encodeURIComponent(interactionId)}/advance`;
      const res = await doFetch(url, { method: "POST", headers, body: JSON.stringify(body) });
      return (await readJson(res, "advance")) as InterviewInteraction;
    },
    async get(interactionId) {
      const res = await doFetch(root, { method: "GET", headers });
      const list = (await readJson(res, "get")) as InterviewInteraction[];
      const found = list.find((i) => i.id === interactionId);
      if (!found) throw new Error(`interview ${interactionId} not found on issue ${issueId}`);
      return found;
    },
  };
}

/**
 * Stateful wrapper around a single interview, holding the latest interaction so
 * a resumed run can read `.step` and act. One instance per wake — cheap to
 * reconstruct from a fetched interaction.
 */
export class InterviewSession {
  private constructor(
    private readonly api: InterviewApi,
    private current: InterviewInteraction,
  ) {}

  /** Open a fresh interview with its first question. */
  static async open(api: InterviewApi, options: OpenInterviewOptions): Promise<InterviewSession> {
    const interaction = await api.open(buildOpenInterviewRequest(options));
    return new InterviewSession(api, interaction);
  }

  /** Resume from an interaction id (typically on a wake_assignee). */
  static async resume(api: InterviewApi, interactionId: string): Promise<InterviewSession> {
    const interaction = await api.get(interactionId);
    return new InterviewSession(api, interaction);
  }

  /** Wrap an interaction already in hand (e.g. from the wake payload). */
  static fromInteraction(api: InterviewApi, interaction: InterviewInteraction): InterviewSession {
    return new InterviewSession(api, interaction);
  }

  get interaction(): InterviewInteraction {
    return this.current;
  }

  get interactionId(): string {
    return this.current.id;
  }

  /** The current decision point for the caller. */
  get step(): InterviewStep {
    return interpretInterview(this.current);
  }

  get isTerminal(): boolean {
    return isInterviewTerminal(this.current);
  }

  /** Re-read state from the API (use when resuming without a fresh interaction). */
  async refresh(): Promise<InterviewStep> {
    this.current = await this.api.get(this.interactionId);
    return this.step;
  }

  /** Append the next question. Valid only when the board has answered the last one. */
  async ask(question: string): Promise<InterviewStep> {
    this.assertReadyToAdvance("ask");
    this.current = await this.api.advance(this.interactionId, buildAskRequest(question));
    return this.step;
  }

  /** Wrap up the interview with an optional summary. */
  async complete(summaryMarkdown?: string | null): Promise<InterviewStep> {
    this.assertReadyToAdvance("complete");
    this.current = await this.api.advance(this.interactionId, buildCompleteRequest(summaryMarkdown));
    return this.step;
  }

  /** Abandon the interview (agent-initiated) with an optional reason. */
  async abandon(reason?: string | null): Promise<InterviewStep> {
    if (this.isTerminal) {
      throw new Error("InterviewSession.abandon: interview is already resolved");
    }
    this.current = await this.api.advance(this.interactionId, buildAbandonRequest(reason));
    return this.step;
  }

  private assertReadyToAdvance(action: "ask" | "complete"): void {
    const phase = this.current.payload.phase;
    if (phase !== "awaiting_next_question") {
      throw new Error(
        `InterviewSession.${action}: interview must be in \`awaiting_next_question\` to advance, but is \`${phase}\`. ` +
          "Wait for the board to answer the open question first.",
      );
    }
  }
}
