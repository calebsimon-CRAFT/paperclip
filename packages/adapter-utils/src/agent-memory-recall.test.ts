import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_AGENT_MEMORY_RECALL_MAX_BYTES,
  DEFAULT_AGENT_MEMORY_RECALL_MAX_LINES,
  boundMemoryHead,
  buildAgentMemoryRecallSection,
  resolveAgentMemoryRecallOptionsFromEnv,
} from "./server-utils.js";

const tempDirs: string[] = [];

async function makeAgentHome(memoryContent: string | null): Promise<string> {
  const home = await mkdtemp(path.join(os.tmpdir(), "tre926-agent-"));
  tempDirs.push(home);
  if (memoryContent !== null) {
    await mkdir(path.join(home, "memory"), { recursive: true });
    await writeFile(path.join(home, "memory", "MEMORY.md"), memoryContent, "utf8");
  }
  return home;
}

// Always pass explicit options so tests don't depend on ambient env.
const ENABLED = { enabled: true } as const;

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe("buildAgentMemoryRecallSection", () => {
  it("is a no-op when the feature flag is disabled", async () => {
    const home = await makeAgentHome("# Memory\n- fact one\n");
    expect(await buildAgentMemoryRecallSection(home, { enabled: false })).toBe("");
  });

  it("injects a labeled recall section from the agent's own MEMORY.md when enabled", async () => {
    const home = await makeAgentHome("# Memory index\n- [thread](x.md) — hook\n");
    const section = await buildAgentMemoryRecallSection(home, ENABLED);
    expect(section).toContain("# Agent memory (recall)");
    expect(section).toContain("$AGENT_HOME/memory/MEMORY.md");
    expect(section).toContain("# Memory index");
    expect(section).toContain("- [thread](x.md) — hook");
  });

  it("degrades open (returns '') when the file is missing", async () => {
    const home = await makeAgentHome(null); // no memory dir at all
    expect(await buildAgentMemoryRecallSection(home, ENABLED)).toBe("");
  });

  it("degrades open (returns '') when agentHome is null/empty", async () => {
    expect(await buildAgentMemoryRecallSection(null, ENABLED)).toBe("");
    expect(await buildAgentMemoryRecallSection("", ENABLED)).toBe("");
    expect(await buildAgentMemoryRecallSection("   ", ENABLED)).toBe("");
  });

  it("returns '' for an empty / whitespace-only memory file", async () => {
    const home = await makeAgentHome("   \n\n   \n");
    expect(await buildAgentMemoryRecallSection(home, ENABLED)).toBe("");
  });

  it("NEVER reads another agent's memory (strictly per-agent, no cross-agent leakage)", async () => {
    const secret = "SUPER-SECRET-AGENT-A-MEMORY-DO-NOT-LEAK";
    const homeA = await makeAgentHome(`# Agent A\n- ${secret}\n`);
    const homeB = await makeAgentHome("# Agent B\n- benign-b-fact\n");

    // Rendering for B must contain ONLY B's content, never A's secret — even
    // though both homes live under the same tmp root.
    const sectionB = await buildAgentMemoryRecallSection(homeB, ENABLED);
    expect(sectionB).toContain("benign-b-fact");
    expect(sectionB).not.toContain(secret);

    // And A's own render is unaffected / isolated.
    const sectionA = await buildAgentMemoryRecallSection(homeA, ENABLED);
    expect(sectionA).toContain(secret);
    expect(sectionA).not.toContain("benign-b-fact");
  });

  it("bounds by line count (keeps the head)", async () => {
    const lines = Array.from({ length: 50 }, (_, i) => `- line ${i}`).join("\n");
    const home = await makeAgentHome(lines);
    const section = await buildAgentMemoryRecallSection(home, { enabled: true, maxLines: 5 });
    expect(section).toContain("- line 0");
    expect(section).toContain("- line 4");
    expect(section).not.toContain("- line 5");
    expect(section).toContain("[memory truncated]");
  });

  it("bounds by byte cap (keeps the head)", async () => {
    const home = await makeAgentHome(`HEAD-MARKER\n${"x".repeat(10_000)}\nTAIL-MARKER`);
    const section = await buildAgentMemoryRecallSection(home, { enabled: true, maxBytes: 128 });
    expect(section).toContain("HEAD-MARKER");
    expect(section).not.toContain("TAIL-MARKER");
    expect(section).toContain("[memory truncated]");
  });
});

describe("boundMemoryHead", () => {
  it("returns the input unchanged when under both caps", () => {
    const raw = "a\nb\nc";
    expect(boundMemoryHead(raw, 1024, 100)).toBe(raw);
  });

  it("never splits a multi-byte UTF-8 character at the byte boundary", () => {
    // "€" is 3 bytes in UTF-8; cap mid-character must back up to a boundary.
    const raw = "€€€€€";
    const bounded = boundMemoryHead(raw, 7, 100); // 7 bytes => 2 full euros
    // No U+FFFD replacement chars from a split codepoint.
    expect(bounded).not.toContain("�");
    expect(bounded.startsWith("€€")).toBe(true);
  });
});

describe("resolveAgentMemoryRecallOptionsFromEnv", () => {
  it("defaults to disabled with the documented caps", () => {
    const opts = resolveAgentMemoryRecallOptionsFromEnv({});
    expect(opts.enabled).toBe(false);
    expect(opts.maxBytes).toBe(DEFAULT_AGENT_MEMORY_RECALL_MAX_BYTES);
    expect(opts.maxLines).toBe(DEFAULT_AGENT_MEMORY_RECALL_MAX_LINES);
  });

  it("parses truthy flags and positive integer caps", () => {
    const opts = resolveAgentMemoryRecallOptionsFromEnv({
      PAPERCLIP_AGENT_MEMORY_RECALL: "true",
      PAPERCLIP_AGENT_MEMORY_RECALL_MAX_BYTES: "4096",
      PAPERCLIP_AGENT_MEMORY_RECALL_MAX_LINES: "42",
    });
    expect(opts.enabled).toBe(true);
    expect(opts.maxBytes).toBe(4096);
    expect(opts.maxLines).toBe(42);
  });

  it("ignores non-positive / non-numeric caps and falls back to defaults", () => {
    const opts = resolveAgentMemoryRecallOptionsFromEnv({
      PAPERCLIP_AGENT_MEMORY_RECALL: "0",
      PAPERCLIP_AGENT_MEMORY_RECALL_MAX_BYTES: "-5",
      PAPERCLIP_AGENT_MEMORY_RECALL_MAX_LINES: "abc",
    });
    expect(opts.enabled).toBe(false);
    expect(opts.maxBytes).toBe(DEFAULT_AGENT_MEMORY_RECALL_MAX_BYTES);
    expect(opts.maxLines).toBe(DEFAULT_AGENT_MEMORY_RECALL_MAX_LINES);
  });
});
