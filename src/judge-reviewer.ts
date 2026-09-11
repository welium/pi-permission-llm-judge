/**
 * The allow-or-ask reviewer: the `Authorizer` chain link this package
 * registers as `"llm-judge"`.
 *
 * Every `ask` on every surface reaches the model — there is no pre-filter, so
 * a benign `read` can be auto-allowed and anything else falls through to the
 * human. The verdict range is `allow | defer` only: a `deny` suggestion from
 * the model is coerced to `defer` because every deny needs human confirm.
 *
 * Every failure path defers — more prompting, never less. This slice never
 * emits `deny`.
 *
 * Observability: every ask this link handles writes one positive
 * `llm_judge.decision` review entry recording the outcome and, on a defer,
 * its reason — so a silent 100%-defer regression (an auth failure, an
 * unresolved model) shows up as a run of `deferReason` entries rather than an
 * empty log. The model's what-it-does `summary` rides on the same record in
 * the prompt-annotation shape (`{ source, text }`, marked model-generated),
 * ready for the annotation slot when the core renders one — the installed
 * core builds payloads with `annotations: []`, so today the summary lives in
 * the review log. The raw model reply goes to the debug log.
 */

import type {
  Authorizer,
  AuthorizerLog,
  AuthorizerVerdict,
  PermissionQuery,
  PromptPermissionDetails,
} from "@gotgenes/pi-permission-system";

import type { LlmJudgeConfig } from "./config-schema.js";
import {
  type CompleteFn,
  type ModelCallDeferReason,
  type ModelRegistryLike,
  reviewAsk,
} from "./model-review.js";
import type { ForcedToolChoice } from "./tool-choice.js";

/** Review-log event: one positive decision record per handled ask. */
const DECISION_EVENT = "llm_judge.decision";
/** Debug-log event: the raw model reply, gated behind `debugLog`. */
const MODEL_REPLY_EVENT = "llm_judge.model_reply";

/** A defer decided before the model call, still recorded positively. */
type PreModelDeferReason = "model-unresolved" | "auth-failed";

/** The shared fields of an `llm_judge.decision` record, before the outcome. */
interface DecisionBase {
  requestId: string;
  surface: string;
  toolName: string | null;
  value: string;
  matchedPattern: string | null;
  modelId: string;
}

/**
 * One `llm_judge.decision` record, whole.
 *
 * The model-call bookkeeping — latency, and the provider API and forcing value
 * the call was addressed with — is discriminated on `modelCalled`, so the
 * "null exactly when no call was made" rule is carried by the type rather than
 * by two object literals agreeing with each other.
 *
 * `api` and `toolChoice` are on the record because a wrong forcing spelling is
 * otherwise invisible: the call succeeds, the model answers in prose, and the
 * entry reads `no-tool-call` with nothing to distinguish it from a model that
 * simply declined the tool.
 *
 * `summary` is the model's what-it-does line plus its annotation source,
 * recorded in the `PromptAnnotation` shape (`{ source, text }`) so it can flow
 * straight into the annotation slot once the core renders one.
 */
type DecisionRecord = DecisionBase & {
  verdict: AuthorizerVerdict["kind"];
  deferReason: ModelCallDeferReason | PreModelDeferReason | null;
  summary: string | null;
  annotationSource: string;
} & (
    | {
        modelCalled: true;
        latencyMs: number;
        api: string;
        toolChoice: ForcedToolChoice;
      }
    | { modelCalled: false; latencyMs: null; api: null; toolChoice: null }
  );

/** The annotation source marking the summary as model-generated. */
const ANNOTATION_SOURCE = "llm-judge";

/** Collaborators for the reviewer, injected so the extension and tests wire them. */
export interface JudgeReviewerDeps {
  /** The loaded config, read live (absent until session config loads). */
  getConfig: () => LlmJudgeConfig | undefined;
  /** The session model registry, read live (captured at `session_start`). */
  getRegistry: () => ModelRegistryLike | undefined;
  /** The model-completion seam (production: `complete` from `@earendil-works/pi-ai`). */
  complete: CompleteFn;
  /** The working directory, for prompt context (read live). */
  getCwd: () => string | undefined;
}

/**
 * Build the `authorize` callback registered on the chain. The `query` argument
 * supplies gate-parity context (the surface's blanket policy) for the judge
 * prompt; the `log` argument is the injected review-log seam the decision
 * trail records to.
 */
export function createJudgeReviewer(
  deps: JudgeReviewerDeps,
): Authorizer["authorize"] {
  return async (details, query, log) => {
    const config = deps.getConfig();
    if (!config) {
      return { kind: "defer" };
    }
    const { requestId } = details;
    const base = baseOf(details, config);

    const registry = deps.getRegistry();
    const model = registry?.find(config.provider, config.model);
    if (!registry || !model) {
      return deferWith(log, base, "model-unresolved");
    }
    const auth = await registry.getApiKeyAndHeaders(model);
    if (!auth.ok) {
      return deferWith(log, base, "auth-failed");
    }

    const outcome = await reviewAsk({
      askPrompt: renderAskPrompt(details, query, config, deps.getCwd()),
      config,
      model,
      complete: deps.complete,
      apiKey: auth.apiKey,
      headers: auth.headers,
    });
    if (outcome.rawReply !== undefined) {
      log.debug(MODEL_REPLY_EVENT, {
        requestId,
        modelId: base.modelId,
        rawReply: outcome.rawReply,
      });
    }
    writeDecision(log, {
      ...base,
      modelCalled: true,
      latencyMs: outcome.latencyMs,
      api: outcome.api,
      toolChoice: outcome.toolChoice,
      verdict: outcome.verdict.kind,
      deferReason: outcome.deferReason ?? null,
      summary: outcome.summary ?? null,
      annotationSource: ANNOTATION_SOURCE,
    });
    return outcome.verdict;
  };
}

/**
 * Record a pre-model defer (`model-unresolved` / `auth-failed`) as a positive
 * `llm_judge.decision` entry and return the defer verdict — so the two
 * model-resolution failures leave evidence on record, not a silent absence.
 */
function deferWith(
  log: AuthorizerLog,
  base: DecisionBase,
  deferReason: PreModelDeferReason,
): AuthorizerVerdict {
  writeDecision(log, {
    ...base,
    modelCalled: false,
    latencyMs: null,
    api: null,
    toolChoice: null,
    verdict: "defer",
    deferReason,
    summary: null,
    annotationSource: ANNOTATION_SOURCE,
  });
  return { kind: "defer" };
}

/**
 * Write one decision record to the review log. The only writer of
 * `DECISION_EVENT`, so neither caller can omit a field or spell the surface
 * differently.
 */
function writeDecision(log: AuthorizerLog, record: DecisionRecord): void {
  log.review(DECISION_EVENT, { ...record });
}

/** The request facts shared by both decision paths. */
function baseOf(
  details: PromptPermissionDetails,
  config: LlmJudgeConfig,
): DecisionBase {
  const request = details.payload.request;
  return {
    requestId: details.requestId,
    surface: request.surface,
    toolName: request.toolName,
    value: request.value,
    matchedPattern: request.matchedPattern,
    modelId: `${config.provider}/${config.model}`,
  };
}

/**
 * Render the ask for the judge model: the invariant request facts, the
 * blanket policy for the surface, then the evidence truncated to
 * `maxEvidenceChars`. The model sees what the human would see, compressed.
 */
function renderAskPrompt(
  details: PromptPermissionDetails,
  query: PermissionQuery,
  config: LlmJudgeConfig,
  cwd: string | undefined,
): string {
  const request = details.payload.request;
  const lines = [
    `surface: ${request.surface}`,
    `tool: ${request.toolName ?? "(n/a)"}`,
    `value: ${request.value}`,
    `matched rule: ${request.matchedPattern ?? "(none)"}`,
  ];
  if (request.executedUnit) {
    lines.push(`will actually run: ${request.executedUnit}`);
  }
  if (request.commandContext) {
    lines.push(`runs inside: ${request.commandContext}`);
  }
  if (request.requester.forwarded) {
    lines.push(
      `requested by subagent: ${request.requester.agentName ?? "(unknown)"}`,
    );
  }
  if (cwd) {
    lines.push(`working directory: ${cwd}`);
  }
  if (request.toolName) {
    try {
      const blanket = query.getToolPermission(request.toolName);
      lines.push(`blanket policy for ${request.toolName}: ${blanket}`);
    } catch {
      // The query is advisory context — never let it fail the review.
    }
  }
  const evidence = details.payload.evidence
    .map((entry) => `${entry.label}: ${entry.text}`)
    .join("\n");
  if (evidence) {
    const truncated =
      evidence.length > config.maxEvidenceChars
        ? `${evidence.slice(0, config.maxEvidenceChars)}…`
        : evidence;
    lines.push("", "evidence:", truncated);
  }
  lines.push(
    "",
    'Call report_verdict with "allow" plus a summary if this is clearly benign, otherwise "defer" with a summary.',
    'If you cannot call tools, reply with ONLY the JSON object {"verdict": "allow" or "defer", "summary": "..."} and no other text.',
  );
  return lines.join("\n");
}
