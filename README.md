# pi-permission-llm-judge

An allow-or-ask LLM judge for Pi — a companion to
[`@gotgenes/pi-permission-system`](https://github.com/gotgenes/pi-packages/tree/main/packages/pi-permission-system).

It registers one `authorizerChain` link (`llm-judge`) that reviews **every**
`ask` across **all** tools/surfaces with a cheap fixed model (default
`bansos/openrouter/free`) through Pi's in-process model registry, and returns only
**`allow` or `defer`**. A `defer` falls through to the normal user dialog, so
the human decides every allow/deny. The judge **never auto-denies** — a model
`deny` suggestion is coerced to `defer` because every deny needs human confirm.

The judge also writes a one-line what-it-does `summary` (action + blast radius)
to the shared permission review log in the prompt-annotation shape
(`{ source: "llm-judge", text }`, marked model-generated), ready for the
annotation slot when the core renders one — the current core builds payloads
with `annotations: []`, so today the summary lives in the review log.

## Install

Clone the repo and install dependencies:

```bash
git clone https://github.com/welium/pi-permission-llm-judge.git
cd pi-permission-llm-judge && npm install
```

Then make sure the same session loads all three expected extensions in
`~/.pi/agent/settings.json` — this judge, the permission chain that hosts
its link, and the provider package behind the default judge model
(no registry publish needed for this checkout):

```jsonc
{
  "packages": [
    "npm:@gotgenes/pi-permission-system", // hosts the authorizerChain
    "npm:pi-bansos"                        // registers the bansos provider
  ],
  "extensions": [
    "~/projects/pi-permission-llm-judge/src/index.ts"
  ]
}
```

(Adjust the path if you cloned the checkout elsewhere.)

| Extension | Why it must be loaded |
| --------- | --------------------- |
| `pi-permission-llm-judge` (this repo) | Registers the `llm-judge` authorizer link. |
| `pi-permission-system` (`@gotgenes/pi-permission-system` 27.0.0+, peer dependency) | Owns the `authorizerChain`; without it in the session there is no chain to join and the link stays unregistered. |
| `pi-bansos` (`npm:pi-bansos`) | Registers the `bansos` provider in Pi's model registry, so the default judge model `bansos/openrouter/free` resolves. Omit it only if you point `provider`/`model` at another loaded provider (see Model choice). |

To share this judge instead, publish the directory as a pi package and
`pi install` it like any other package.

Also requires `@earendil-works/pi-ai` 0.84.3 or later (provided by Pi).

## Enable

1. In your **pi-permission-system** config, opt in to the link (registration
   alone grants no authority):

   ```jsonc
   // ~/.pi/agent/extensions/pi-permission-system/config.json
   { "authorizerChain": ["llm-judge"] }
   ```

2. Optionally tune **this** extension's config (all fields have defaults, so
   this step is skippable):

   ```jsonc
   // ~/.pi/agent/extensions/pi-permission-llm-judge/config.json
   {
     "provider": "bansos",
     "model": "openrouter/free",
     "timeoutMs": 60000,
     "maxEvidenceChars": 2000
   }
   ```

   Config is layered — a project file
   (`.pi/extensions/pi-permission-llm-judge/config.json` under your project root)
   overrides the global one. See [`config/config.example.json`](config/config.example.json)
   and [`schemas/llm-judge.schema.json`](schemas/llm-judge.schema.json).

| Field              | Default             | Description                                                        |
| ------------------ | ------------------- | ------------------------------------------------------------------ |
| `provider`         | `bansos`            | Model provider, resolved against Pi's model registry.              |
| `model`            | `openrouter/free`   | Model id within the provider.                                      |
| `instructions`     | (built-in)          | System prompt: allow only clearly-benign actions, else defer.      |
| `timeoutMs`        | `60000`             | Per-review model-call budget in ms; a timeout defers. Free-tier relays are slow — keep this above their tail latency. |
| `maxEvidenceChars` | `2000`              | Cap on evidence text forwarded into the judge prompt.              |

## Model choice

The judge does not bundle a model: on each `ask` it resolves
`provider`/`model` from this extension's config against Pi's in-process
model registry (`registry.find(provider, model)`) and reuses the registry's
auth for that model. Only the judge call uses it — your chat model is
unaffected.

- **Default: `bansos/openrouter/free`.** A free pi-bansos model, good enough
  for benign-vs-not triage and keyless. Requires the `pi-bansos` package in
  the same session (see Install).
- **Pin another free model** from the same provider — any model id the
  `bansos` provider registers works:

  ```jsonc
  // ~/.pi/agent/extensions/pi-permission-llm-judge/config.json
  {
    "provider": "bansos",
    "model": "mimo-v2.5-free"
  }
  ```

- **Use a different provider entirely** — any provider loaded in the session
  works, with one hard requirement: **the model must accept tool calls**.
  The judge forces a `report_verdict` call on every review, so a model whose
  API rejects tool parameters fails *every* ask. Known-bad example:
  `opencode/big-pickle` does not support tool calls — pointing the judge at
  it defers everything and approvals silently stop.

If the pair does not resolve, or its auth fails, the link defers every ask
back to the human and records why (`model-unresolved` / `auth-failed` in the
`llm_judge.decision` review-log entry) — a wrong model choice costs you
auto-approvals, never safety. A model that accepts the call but answers in
prose instead of calling the tool is honored only if it emits exactly the
pinned verdict JSON object; anything else defers as `no-tool-call`. After
any model change, check the review log: a run of `call-failed` or
`no-tool-call` means the model can't serve as judge — switch back or pick
another.

## How it works

On `permissions:ready` the extension registers the `llm-judge` link via
`getPermissionsService(sessionId).registerAuthorizer`. On each `ask` the link:

1. Resolves the cheap model from the session registry and its auth.
2. Builds a judge prompt from the ask's request facts
   (surface, tool, value, matched rule, executed unit, requester, cwd) plus
   the blanket policy for the surface and the evidence (truncated).
3. Forces the model to call `report_verdict({ verdict: "allow" | "defer", summary })`. The prompt pins the same verdict JSON contract instructor-style, so a model that drops the tool call but emits exactly that object is still honored; anything else defers.
4. Records one `llm_judge.decision` review-log entry (outcome, latency, api,
   tool-choice spelling, summary) and returns the verdict.

Fail-safe by construction: missing config, unresolved model, auth failure,
timeout, unparseable reply, or a non-`allow` verdict all resolve to `defer`.
Deferring means the ask falls through to the normal permission prompt — this
extension only ever *removes* a hand-approval, never grants access it
shouldn't (and the core's bounded-delegation cap still downgrades any link
`allow` on the `path`/`external_directory` families to `defer`).

## Scope and non-goals

- Verdicts are `allow` or `defer`, never `deny`.
- No verdict cache — stateless per `requestId`.
- No changes to `@gotgenes/pi-permission-system` — the authorizer seam is
  consumed as it ships.

## Development

```bash
npm run check  # tsc --noEmit
npm test       # vitest run
```

## License

MIT
