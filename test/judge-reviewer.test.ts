/**
 * Unit tests for the allow-or-ask reviewer: verdict mapping, fail-safe
 * paths, and the decision-trail record. The model is always faked — no
 * network, no registry.
 */

import { describe, expect, it, vi } from "vitest";

import type {
  AuthorizerLog,
  PermissionQuery,
  PromptPermissionDetails,
} from "@gotgenes/pi-permission-system";

import {
  DEFAULT_INSTRUCTIONS,
  type LlmJudgeConfig,
} from "../src/config-schema.js";
import { createJudgeReviewer } from "../src/judge-reviewer.js";
import type { CompleteFn, ModelRegistryLike } from "../src/model-review.js";

const CONFIG: LlmJudgeConfig = {
  provider: "bansos",
  model: "openrouter/free",
  instructions: DEFAULT_INSTRUCTIONS,
  timeoutMs: 15000,
  maxEvidenceChars: 2000,
};

function details(): PromptPermissionDetails {
  return {
    requestId: "req-1",
    source: "tool_call",
    agentName: null,
    payload: {
      kind: "tool",
      request: {
        requester: { agentName: null, forwarded: false, sessionId: null },
        surface: "read",
        toolName: "read",
        invokedToolName: null,
        value: "src/index.ts",
        matchedPattern: "*",
        commandContext: null,
        executedUnit: null,
      },
      evidence: [{ label: "path", text: "src/index.ts", detail: null }],
      annotations: [],
    },
    toolCallId: "call-1",
    toolName: "read",
  };
}

function query(): PermissionQuery {
  return {
    checkPermission: () => ({
      state: "ask",
      matchedPattern: "*",
      source: "test",
      origin: null,
    }),
    getToolPermission: () => "ask",
  } as unknown as PermissionQuery;
}

function log() {
  return {
    review: vi.fn(),
    debug: vi.fn(),
  } satisfies AuthorizerLog;
}

function registryWith(model: unknown): ModelRegistryLike {
  return {
    find: () => model as never,
    getApiKeyAndHeaders: () => Promise.resolve({ ok: true as const }),
  };
}

function toolReply(verdict: string, summary = "Does X.") {
  return {
    complete: (async () => ({
      content: [
        {
          type: "toolCall",
          toolCallId: "t",
          arguments: { verdict, summary },
        },
      ],
    })) as unknown as CompleteFn,
  };
}

describe("createJudgeReviewer", () => {
  it("returns allow when the model verdict is allow", async () => {
    const authorize = createJudgeReviewer({
      getConfig: () => CONFIG,
      getRegistry: () => registryWith({ api: "openai-completions" }),
      getCwd: () => "/work",
      ...toolReply("allow", "Reads src/index.ts (no side effects)."),
    });
    const verdict = await authorize(details(), query(), log());
    expect(verdict).toEqual({ kind: "allow" });
  });

  it("coerces a model deny suggestion to defer (deny needs human confirm)", async () => {
    const logs = log();
    const authorize = createJudgeReviewer({
      getConfig: () => CONFIG,
      getRegistry: () => registryWith({ api: "openai-completions" }),
      getCwd: () => "/work",
      ...toolReply("deny", "Deletes everything."),
    });
    const verdict = await authorize(details(), query(), logs);
    expect(verdict).toEqual({ kind: "defer" });
    expect(logs.review).toHaveBeenCalledWith(
      "llm_judge.decision",
      expect.objectContaining({
        verdict: "defer",
        deferReason: "non-allow-verdict",
        summary: "Deletes everything.",
      }),
    );
  });

  it("returns allow when a tool-less model emits the pinned verdict JSON", async () => {
    const logs = log();
    const authorize = createJudgeReviewer({
      getConfig: () => CONFIG,
      getRegistry: () => registryWith({ api: "openai-completions" }),
      getCwd: () => "/work",
      complete: (async () => ({
        content: [
          {
            type: "text",
            text: '{"verdict": "allow", "summary": "Reads src/index.ts (no side effects)."}',
          },
        ],
      })) as unknown as CompleteFn,
    });
    const verdict = await authorize(details(), query(), logs);
    expect(verdict).toEqual({ kind: "allow" });
    expect(logs.review).toHaveBeenCalledWith(
      "llm_judge.decision",
      expect.objectContaining({
        verdict: "allow",
        summary: "Reads src/index.ts (no side effects).",
      }),
    );
  });

  it("defers a fenced JSON defer as non-allow-verdict, keeping the summary", async () => {
    const logs = log();
    const authorize = createJudgeReviewer({
      getConfig: () => CONFIG,
      getRegistry: () => registryWith({ api: "openai-completions" }),
      getCwd: () => "/work",
      complete: (async () => ({
        content: [
          {
            type: "text",
            text: '```json\n{"verdict": "defer", "summary": "Edits a file."}\n```',
          },
        ],
      })) as unknown as CompleteFn,
    });
    const verdict = await authorize(details(), query(), logs);
    expect(verdict).toEqual({ kind: "defer" });
    expect(logs.review).toHaveBeenCalledWith(
      "llm_judge.decision",
      expect.objectContaining({
        verdict: "defer",
        deferReason: "non-allow-verdict",
        summary: "Edits a file.",
      }),
    );
  });

  it("defers prose without verdict JSON as no-tool-call", async () => {
    const logs = log();
    const authorize = createJudgeReviewer({
      getConfig: () => CONFIG,
      getRegistry: () => registryWith({ api: "openai-completions" }),
      getCwd: () => "/work",
      complete: (async () => ({
        content: [{ type: "text", text: "This looks fine to me, I guess." }],
      })) as unknown as CompleteFn,
    });
    const verdict = await authorize(details(), query(), logs);
    expect(verdict).toEqual({ kind: "defer" });
    expect(logs.review).toHaveBeenCalledWith(
      "llm_judge.decision",
      expect.objectContaining({
        verdict: "defer",
        deferReason: "no-tool-call",
      }),
    );
  });

  it("coerces a text JSON deny suggestion to defer", async () => {
    const authorize = createJudgeReviewer({
      getConfig: () => CONFIG,
      getRegistry: () => registryWith({ api: "openai-completions" }),
      getCwd: () => "/work",
      complete: (async () => ({
        content: [
          { type: "text", text: '{"verdict": "deny", "summary": "No."}' },
        ],
      })) as unknown as CompleteFn,
    });
    const verdict = await authorize(details(), query(), log());
    expect(verdict).toEqual({ kind: "defer" });
  });

  it("defers with model-unresolved when the registry has no model", async () => {
    const logs = log();
    const authorize = createJudgeReviewer({
      getConfig: () => CONFIG,
      getRegistry: () => registryWith(undefined),
      getCwd: () => "/work",
      ...toolReply("allow"),
    });
    const verdict = await authorize(details(), query(), logs);
    expect(verdict).toEqual({ kind: "defer" });
    expect(logs.review).toHaveBeenCalledWith(
      "llm_judge.decision",
      expect.objectContaining({
        verdict: "defer",
        deferReason: "model-unresolved",
        modelCalled: false,
      }),
    );
  });

  it("defers when complete throws (call-failed), never denying", async () => {
    const authorize = createJudgeReviewer({
      getConfig: () => CONFIG,
      getRegistry: () => registryWith({ api: "openai-completions" }),
      getCwd: () => "/work",
      complete: (() => Promise.reject(new Error("401"))) as CompleteFn,
    });
    const verdict = await authorize(details(), query(), log());
    expect(verdict).toEqual({ kind: "defer" });
  });

  it("defers when there is no config (safe no-op)", async () => {
    const authorize = createJudgeReviewer({
      getConfig: () => undefined,
      getRegistry: () => registryWith({}),
      getCwd: () => undefined,
      ...toolReply("allow"),
    });
    const verdict = await authorize(details(), query(), log());
    expect(verdict).toEqual({ kind: "defer" });
  });
});
