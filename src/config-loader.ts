/**
 * Layered config loader: global then project `config.json`, project overriding
 * global, validated once against the zod source of truth.
 *
 * Fail-safe by construction: a malformed file is skipped with a recorded issue
 * (never fatal), and an invalid merged config yields `{ config: undefined }` so
 * the extension registers no link — a config error degrades to normal
 * prompting, never to a wrong decision.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  LLM_JUDGE_EXTENSION_ID,
  type LlmJudgeConfig,
  llmJudgeConfigSchema,
} from "./config-schema.js";

const CONFIG_FILE_NAME = "config.json";

/** A validation or read problem, tied to the file that produced it. */
export interface ConfigIssue {
  path: string;
  message: string;
  sourcePath?: string;
}

/** Outcome of a config load: a validated config (or `undefined`) plus issues. */
export interface LoadConfigResult {
  config: LlmJudgeConfig | undefined;
  issues: ConfigIssue[];
}

/** Global scope: `<agentDir>/extensions/<id>/config.json`. */
export function getGlobalConfigPath(agentDir: string): string {
  return join(agentDir, "extensions", LLM_JUDGE_EXTENSION_ID, CONFIG_FILE_NAME);
}

/** Project scope: `<cwd>/.pi/extensions/<id>/config.json`. */
export function getProjectConfigPath(cwd: string): string {
  return join(
    cwd,
    ".pi",
    "extensions",
    LLM_JUDGE_EXTENSION_ID,
    CONFIG_FILE_NAME,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read and JSON-parse a layer. Returns `undefined` when the file is absent;
 * records an issue and returns `undefined` when it is present but malformed.
 */
function readLayer(
  path: string,
  issues: ConfigIssue[],
): Record<string, unknown> | undefined {
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (!isRecord(parsed)) {
      issues.push({
        path: "$",
        message: "Expected a JSON object.",
        sourcePath: path,
      });
      return undefined;
    }
    return parsed;
  } catch (error) {
    issues.push({
      path: "$",
      message: error instanceof Error ? error.message : String(error),
      sourcePath: path,
    });
    return undefined;
  }
}

export interface LoadModelJudgeConfigOptions {
  cwd: string;
  agentDir: string;
}

/**
 * Load global then project config, merge (project wins per key), and validate.
 * No file at either scope yields the schema defaults — the link still
 * registers with the cheap fixed model. An invalid merged config yields
 * `{ config: undefined }` plus issues.
 */
export function loadLlmJudgeConfig(
  options: LoadModelJudgeConfigOptions,
): LoadConfigResult {
  const issues: ConfigIssue[] = [];
  const globalLayer = readLayer(getGlobalConfigPath(options.agentDir), issues);
  const projectLayer = readLayer(getProjectConfigPath(options.cwd), issues);
  const merged = { ...(globalLayer ?? {}), ...(projectLayer ?? {}) };
  const parsed = llmJudgeConfigSchema.safeParse(merged);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      issues.push({
        path: issue.path.join(".") || "$",
        message: issue.message,
      });
    }
    return { config: undefined, issues };
  }
  return { config: parsed.data, issues };
}
