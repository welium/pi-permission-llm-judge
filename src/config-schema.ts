/**
 * The zod source of truth for the llm-judge extension config.
 *
 * The config carries the *model mechanism* half of the authorizer split
 * (provider / model / instructions / budgets); the *chain policy* half
 * (`authorizerChain`, the delegation envelope) lives in
 * `@gotgenes/pi-permission-system`. This package reads only what it uses.
 */

import { z } from "zod";

/** Extension id — the `extensions/<id>/config.json` path segment. */
export const LLM_JUDGE_EXTENSION_ID = "pi-permission-llm-judge";

/** Canonical URL of the published config JSON Schema (the root `$id`). */
export const LLM_JUDGE_SCHEMA_URL =
 "https://raw.githubusercontent.com/welium/pi-permission-llm-judge/main/schemas/llm-judge.schema.json";

/** Default per-review model-call budget, in milliseconds. Free-tier relays are slow; keep this above their tail latency. */
export const DEFAULT_TIMEOUT_MS = 60000;

/** Default cap on evidence text forwarded into the judge prompt. */
export const DEFAULT_MAX_EVIDENCE_CHARS = 2000;

/** Default judge instructions: allow only when clearly benign, else defer. */
export const DEFAULT_INSTRUCTIONS = [
 "You review a permission ask from a coding agent. The agent wants to perform an action and the deterministic policy could not decide, so it asks you.",
 'Reply with verdict "allow" ONLY when the action is clearly benign and reversible: reading files, listing directories, running read-only commands (git status, git diff, ls, cat of non-sensitive files).',
 'Reply with verdict "defer" for anything else: writes, edits, deletes, installs, network calls, shell commands with side effects, access to secrets (.env, keys, credentials), anything outside the working directory you cannot vouch for, or anything you are unsure about.',
 "You NEVER deny. A deferred ask goes to the human, who decides allow or deny.",
 'Always include a one-line "summary" saying what the action does and its blast radius (e.g. "Reads src/index.ts (no side effects)" or "Deletes build output via rm -rf dist (irreversible write)").',
 'Call the report_verdict tool with your answer. If you cannot call tools, output ONLY one JSON object with exactly these keys and nothing else — no prose, no code fences: {"verdict": "allow" or "defer", "summary": "..."}.',
].join(" ");

/**
 * Operator-owned config for the allow-or-ask reviewer.
 *
 * `provider`/`model` default to the free judge model
 * (`bansos/openrouter/free`); override them to pin a different judge model.
 * Absent files yield the schema defaults (the link still registers); an
 * invalid merged config yields `undefined` so no link registers — a safe no-op.
 */
export const llmJudgeConfigSchema = z.object({
 provider: z.string().min(1).default("bansos"),
 model: z.string().min(1).default("openrouter/free"),
 instructions: z.string().min(1).default(DEFAULT_INSTRUCTIONS),
 timeoutMs: z.number().int().positive().default(DEFAULT_TIMEOUT_MS),
 maxEvidenceChars: z
  .number()
  .int()
  .positive()
  .default(DEFAULT_MAX_EVIDENCE_CHARS),
});

export type LlmJudgeConfig = z.infer<typeof llmJudgeConfigSchema>;
