# AGENTS.md — pi-permission-llm-judge

An allow-or-ask LLM judge for Pi, registered as one `authorizerChain` link
(`llm-judge`) on `@gotgenes/pi-permission-system`. It reviews every `ask`
with a cheap model and returns only `allow` or `defer`. A `defer` falls
through to the normal user dialog. **This package never emits `deny`** — a
model `deny` suggestion is coerced to `defer` because every deny needs human
confirm.

## Commands

```bash
npm run check  # tsc --noEmit
npm test       # vitest run
```

Node >= 22. No build step — Pi loads `src/index.ts` directly (see `pi.extensions` in `package.json`).

## Layout

- `src/index.ts` — extension entry point, delegates to `extension.ts`.
- `src/extension.ts` — Pi wiring: loads config on `session_start`, registers the `llm-judge` link on `permissions:ready` (idempotence guard — the event may repeat), disposes on `session_shutdown`. Injectable `loadConfig` / `complete` seams for tests.
- `src/judge-reviewer.ts` — the `Authorizer["authorize"]` callback. Resolves model → auth → `reviewAsk`, writes one `llm_judge.decision` review-log entry per handled ask (except the missing-config path, which defers silently). Also renders the ask prompt from request facts + blanket policy + truncated evidence.
- `src/model-review.ts` — the bounded model call (`report_verdict` forced tool + instructor-style JSON fallback via `readJsonVerdict`), `timeoutMs` abort, and the `allow | defer` mapping. Owns `ReviewOutcome` (verdict, deferReason, latency, api, toolChoice, summary, rawReply). Fallback accepts the whole reply, one fenced block, or the first `{...}` span; extra keys ignored, missing `verdict` → `no-tool-call`, text `deny` → `non-allow-verdict` (coerced to `defer`).
- `src/tool-choice.ts` — per-API forced-tool spelling (`any` vs `required`), keyed on `Model.api`. Unknown APIs default to `required` (OpenAI-compatible assumption).
- `src/config-schema.ts` — zod source of truth (defaults: `bansos/openrouter/free`, `timeoutMs` 60000, `maxEvidenceChars` 2000). Also exports `LLM_JUDGE_EXTENSION_ID` and `LLM_JUDGE_SCHEMA_URL`.
- `src/config-loader.ts` — layered config: global `<agentDir>/extensions/pi-permission-llm-judge/config.json`, project `<cwd>/.pi/extensions/pi-permission-llm-judge/config.json` (project wins per key). Malformed files are skipped with recorded issues, never fatal; invalid merged config → no link registered (safe no-op).
- `config/config.example.json`, `schemas/llm-judge.schema.json` — example config and published JSON Schema.
- `test/judge-reviewer.test.ts` — reviewer tests with fake registry/`complete`.

## Invariants (do not break)

1. **Verdict range is `allow | defer` only.** No code path may return `deny`. `non-allow-verdict` (including `deny` text) coerces to `defer`.
2. **Fail-safe: every failure defers.** Missing config, unresolved model, auth failure, timeout, throw, unparseable reply → `defer` (more prompting, never less).
3. **No pre-filter.** Every `ask` on every surface reaches the reviewer; benign reads can auto-allow, everything else defers to the human.
4. **No verdict cache.** Stateless per `requestId`.
5. **No changes to the permission-system package.** The authorizer seam is consumed as shipped.
6. **Observability is mandatory.** Every handled ask writes one positive `llm_judge.decision` review entry (including pre-model defers `model-unresolved` / `auth-failed`; only the missing-config early return defers silently); raw replies go to `llm_judge.model_reply` debug log. A silent all-defer regression must be visible in the trail.
7. **Tool calls are read by position, not name.** Under OAuth the provider rewrites the registered tool name — use the first `toolCall`, never match on `report_verdict`.
8. **Judge models must accept forced tool calls.** `reviewAsk` always sends a forced `toolChoice`; a model whose API rejects tool parameters (e.g. `opencode/big-pickle`) fails every ask with `call-failed` defers. The text-JSON fallback only covers models that accept the call but answer in prose — never recommend a tool-less model as judge.

## Conventions

- ESM with `.js`-suffixed relative imports (`./extension.js`) and `#src/*` / `#test/*` path aliases (see `tsconfig.json` + `package.json` `imports`).
- `complete` is imported from `@earendil-works/pi-ai/compat` (the `complete` export lives there since pi-ai 0.84). Don't move it to the package root.
- `tool-choice.ts` keys on plain strings, not pi-ai's `KnownApi` union — a new API in a pi-ai release must degrade to the default, not break the build.
- Peer deps (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@gotgenes/pi-permission-system`) are provided by the Pi session; only `zod` is a runtime dependency.
- Keep the long `/** */` design comments — they record non-obvious runtime facts (provider rewrites, forcing-spelling behavior, event ordering). Update them when the facts change.
- Config default changes must land in three places together: `config-schema.ts`, `schemas/llm-judge.schema.json`, `config/config.example.json`. README documents user-facing behavior — update it alongside behavior changes.
