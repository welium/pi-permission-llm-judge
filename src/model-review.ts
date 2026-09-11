/**
 * The model call: ask a cheap model whether an ask is clearly benign,
 * bounded by `timeoutMs`, and map its reply to an `allow | defer` verdict.
 *
 * Fail-safe throughout — an unparseable reply, a non-`allow` verdict, a
 * `deny` suggestion (deny always needs human confirm), a thrown or timed-out
 * `complete`, all resolve to `defer` (more prompting, never less). This slice
 * never emits `deny`.
 */

import type {
 AssistantMessage,
 Context,
 Model,
 ProviderHeaders,
 TextContent,
 Tool,
 ToolCall,
} from "@earendil-works/pi-ai";
import type { AuthorizerVerdict } from "@gotgenes/pi-permission-system";

import type { LlmJudgeConfig } from "./config-schema.js";
import { type ForcedToolChoice, resolveToolChoice } from "./tool-choice.js";

/**
 * The single tool the model is forced to call. Forcing it removes free-text
 * JSON parsing by construction — the verdict arrives as structured
 * `arguments`, so a Markdown fence or a prose preamble can no longer cost a
 * verdict. The forcing value itself is per provider API; see `tool-choice.ts`.
 *
 * The Anthropic provider reads only `parameters.properties` /
 * `parameters.required`, so a plain JSON-Schema object is correct at runtime;
 * the `as unknown as Tool` bridge satisfies the `TSchema`-typed `parameters`
 * field without a `typebox` dependency.
 *
 * SAFETY: `parameters` is a plain JSON-Schema object, which is what the
 * providers read at runtime; the double assertion only bridges the static
 * `TSchema` field type, and the object is never mutated after this point.
 */
const VERDICT_TOOL = {
 name: "report_verdict",
 description:
  "Report whether the action is clearly benign (allow) or should go to the human (defer). You never deny.",
 parameters: {
  type: "object",
  properties: {
   verdict: {
    type: "string",
    enum: ["allow", "defer"],
    description: "allow a clearly benign action; defer anything else",
   },
   summary: {
    type: "string",
    description: "One line saying what the action does and its blast radius",
   },
  },
  required: ["verdict", "summary"],
 },
} as unknown as Tool;

/**
 * The injected model-completion seam — structurally the `complete` export of
 * `@earendil-works/pi-ai`. Injected so tests substitute a fake.
 */
export type CompleteFn = (
 model: Model<any>,
 context: Context,
 options?: {
  signal?: AbortSignal;
  apiKey?: string;
  headers?: ProviderHeaders;
  toolChoice?: ForcedToolChoice;
 },
) => Promise<AssistantMessage>;

/**
 * The auth resolved for a model call — structurally the `ResolvedRequestAuth`
 * of the core `ModelRegistry`, redeclared here because that type is not
 * re-exported from `@earendil-works/pi-coding-agent`.
 */
export type ResolvedRequestAuth =
 | { ok: true; apiKey?: string; headers?: ProviderHeaders }
 | { ok: false; error: string };

/** The narrow model-registry projection the reviewer needs (ISP). */
export interface ModelRegistryLike {
 find(provider: string, modelId: string): Model<any> | undefined;
 getApiKeyAndHeaders(model: Model<any>): Promise<ResolvedRequestAuth>;
}

/**
 * Why a model call defers, distinct enough to diagnose from the decision
 * trail: the reply carried no tool call to read (`no-tool-call`), the tool
 * call named a verdict other than `allow` (`non-allow-verdict` — including a
 * `deny` suggestion, which always needs human confirm), the call was aborted
 * at `timeoutMs` (`timeout`), or `complete` threw for any other reason
 * (`call-failed` — the honest superset that catches, e.g., a 401 slipping
 * past pre-call auth resolution).
 */
export type ModelCallDeferReason =
 | "no-tool-call"
 | "non-allow-verdict"
 | "timeout"
 | "call-failed";

/**
 * The full result of a model review: the verdict plus the observability the
 * decision trail records. `deferReason` is set iff the verdict is `defer`;
 * `rawReply` carries the tool-call arguments as JSON when a tool call
 * arrived, or the assistant text on a `no-tool-call` defer (absent on a
 * timeout/throw before any reply). `summary` is the model's what-it-does
 * line, recorded for the prompt-annotation slot and the review log.
 */
export interface ReviewOutcome {
 verdict: AuthorizerVerdict;
 summary?: string;
 deferReason?: ModelCallDeferReason;
 latencyMs: number;
 rawReply?: string;
 /** The `Model.api` the call was addressed to. */
 api: string;
 /** The forcing spelling actually sent, so a mismatch is readable from the trail. */
 toolChoice: ForcedToolChoice;
}

/** Inputs for a single ask review. */
export interface ReviewAskInputs {
 /** The rendered ask facts handed to the model. */
 askPrompt: string;
 config: LlmJudgeConfig;
 model: Model<any>;
 complete: CompleteFn;
 apiKey?: string;
 headers?: ProviderHeaders;
}

/**
 * Review one ask with the model and return the structured outcome.
 *
 * The call is aborted after `config.timeoutMs`; an abort, a rejection, or any
 * non-`allow` reply yields `defer` (more prompting, never less) with the
 * reason annotated so the caller can record why.
 */
export async function reviewAsk(
 inputs: ReviewAskInputs,
): Promise<ReviewOutcome> {
 const controller = new AbortController();
 const timer = setTimeout(() => {
  controller.abort();
 }, inputs.config.timeoutMs);
 const startedAt = Date.now();
 // Resolved before the call so a timeout or a rejection still reports what
 // went on the wire. A model without an `api` resolves to the default
 // spelling, the same as an api the map does not name.
 const api = typeof inputs.model.api === "string" ? inputs.model.api : "";
 const toolChoice = resolveToolChoice(api);
 try {
  const context: Context = {
   systemPrompt: inputs.config.instructions,
   tools: [VERDICT_TOOL],
   messages: [
    {
     role: "user",
     content: inputs.askPrompt,
     timestamp: Date.now(),
    },
   ],
  };
  const reply = await inputs.complete(inputs.model, context, {
   signal: controller.signal,
   apiKey: inputs.apiKey,
   headers: inputs.headers,
   toolChoice,
  });
  return {
   ...readToolCallOutcome(reply),
   latencyMs: Date.now() - startedAt,
   api,
   toolChoice,
  };
 } catch {
  return {
   verdict: { kind: "defer" },
   deferReason: controller.signal.aborted ? "timeout" : "call-failed",
   latencyMs: Date.now() - startedAt,
   api,
   toolChoice,
  };
 } finally {
  clearTimeout(timer);
 }
}

/**
 * Map the forced tool call to a verdict; anything but a clean `allow` defers
 * with the reason that distinguishes it — including a `deny` suggestion, which
 * always needs human confirm and is therefore coerced to `defer`. The tool
 * call is read by position (the first one), not by name — under OAuth the
 * provider rewrites the registered name, so the reply's tool-call name cannot
 * be relied on.
 *
 * Instructor-style fallback: the prompt pins the same verdict JSON contract
 * for models that cannot call tools. A text reply that parses as exactly that
 * object is honored like a tool call — same model, same call, same schema,
 * only the transport differed. Anything else stays a `no-tool-call` defer.
 *
 * Per-call bookkeeping such as `latencyMs` is stamped by `reviewAsk`, which
 * owns the call — keeping it out of here means a new per-call field lands at
 * one place rather than at every verdict branch.
 */
function readToolCallOutcome(
 reply: AssistantMessage,
): Pick<ReviewOutcome, "verdict" | "summary" | "deferReason" | "rawReply"> {
 const call = reply.content.find(
  (part): part is ToolCall => part.type === "toolCall",
 );
 if (!call) {
  const text = extractText(reply);
  const fallback = readJsonVerdict(text);
  if (fallback) {
   return { ...fallback, rawReply: text };
  }
  return {
   verdict: { kind: "defer" },
   deferReason: "no-tool-call",
   rawReply: text,
  };
 }
 const args = call.arguments as Record<string, unknown>;
 const rawReply = JSON.stringify(args);
 const summary =
  typeof args.summary === "string" && args.summary.length > 0
   ? args.summary
   : undefined;
 if (args.verdict !== "allow") {
  return {
   verdict: { kind: "defer" },
   summary,
   deferReason: "non-allow-verdict",
   rawReply,
  };
 }
 return { verdict: { kind: "allow" }, summary, rawReply };
}

/**
 * Parse a text-only reply as the pinned verdict JSON contract.
 *
 * Accepts the whole reply, one fenced block, or the first `{...}` span inside
 * prose — then validates: it must be an object with a string `verdict`.
 * `allow` allows; any other verdict string defers as `non-allow-verdict` (a
 * text `deny` is coerced exactly like a tool-call `deny`); a missing verdict
 * is not a verdict at all and yields `undefined` (`no-tool-call`). Extra keys
 * are ignored — strict on shape, lenient on passengers.
 */
function readJsonVerdict(
 text: string,
): Pick<ReviewOutcome, "verdict" | "summary" | "deferReason"> | undefined {
 const trimmed = text.trim();
 if (!trimmed) {
  return undefined;
 }
 const candidates = [trimmed, pickObjectSpan(trimmed)];
 for (const candidate of candidates) {
  if (!candidate) {
   continue;
  }
  const parsed = tryParseObject(stripFences(candidate).trim());
  if (!parsed) {
   continue;
  }
  const verdict = parsed.verdict;
  if (typeof verdict !== "string") {
   return undefined;
  }
  const summary =
   typeof parsed.summary === "string" && parsed.summary.length > 0
    ? parsed.summary
    : undefined;
  if (verdict !== "allow") {
   return {
    verdict: { kind: "defer" },
    summary,
    deferReason: "non-allow-verdict",
   };
  }
  return { verdict: { kind: "allow" }, summary };
 }
 return undefined;
}

/** Remove one surrounding Markdown code fence, if present. */
function stripFences(text: string): string {
 const match = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
 return match ? match[1] : text;
}

/** The span from the first `{` to the last `}`, or `undefined` when absent. */
function pickObjectSpan(text: string): string | undefined {
 const start = text.indexOf("{");
 const end = text.lastIndexOf("}");
 return start >= 0 && end > start ? text.slice(start, end + 1) : undefined;
}

/** `JSON.parse` narrowed to a plain object, or `undefined`. */
function tryParseObject(text: string): Record<string, unknown> | undefined {
 try {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
   return parsed as Record<string, unknown>;
  }
 } catch {
  // Not JSON — the caller moves on to `no-tool-call`.
 }
 return undefined;
}

/** Concatenate the text parts of an assistant reply. */
function extractText(reply: AssistantMessage): string {
 return reply.content
  .filter((part): part is TextContent => part.type === "text")
  .map((part) => part.text)
  .join("");
}
