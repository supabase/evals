# Vercel AI Gateway — Evaluation Report

**Date:** 2026-07-24
**Status:** Exploration only — no code changes. The goal is to build a gateway-backed path *alongside* the current direct-provider system, run both for a while, and then decide to keep or remove it.
**Branch:** `explore/ai-gateway-vendor-provider`

---

## 1. What the Vercel AI Gateway is

The [Vercel AI Gateway](https://vercel.com/docs/ai-gateway) is a unified API proxy in front of hundreds of AI models from ~34 vendors. Instead of holding one API key per provider (Anthropic, OpenAI, Google, xAI, …), you hold **one AI Gateway API key** and address models as `creator/model-name` slugs (e.g. `anthropic/claude-opus-4.8`, `openai/gpt-5.5`). The gateway authenticates to the upstream provider, routes the request, and returns the provider's response with ~20ms of added routing latency.

It exposes three API surfaces, all at `https://ai-gateway.vercel.sh`:

| Surface | Endpoint | Relevant to us |
|---|---|---|
| AI SDK / Gateway API | `/v1/ai` (default for `@ai-sdk/gateway` / plain `"provider/model"` strings in the AI SDK) | `aiSdkAgent` and the judge model |
| OpenAI-compatible | `/v1` (Chat Completions + Responses API, incl. WebSocket streaming) | Codex CLI |
| Anthropic-compatible | `/v1/messages` (+ `/v1/messages/count_tokens`) | Claude Code CLI |

Authentication is either a static `AI_GATEWAY_API_KEY` or a Vercel OIDC token; the Anthropic surface accepts the key via `x-api-key` or `Authorization: Bearer`.

## 2. What it offers

- **One key, every provider.** A single team-scoped key (multiple named keys supported) replaces per-vendor accounts and keys. Usage is broken down per key and per project in the dashboard.
- **Zero markup on tokens.** Tokens are billed at the provider's list price ([pricing docs](https://vercel.com/docs/ai-gateway/pricing)).
- **Bring Your Own Key (BYOK).** Our existing `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` can be registered (team-wide in the dashboard, or per-request via `providerOptions.gateway.byok`). The gateway then authenticates with *our* keys at no gateway fee, and automatically retries with Vercel's system credentials if our key fails (that fallback usage is billed against gateway credits). BYOK requires the paid tier (purchased credits).
- **Reliability / failover.** Automatic retry across providers hosting the same model, plus explicit `order` / `only` provider filtering and `models` fallback lists per request. Claude Code can pass these via `CLAUDE_CODE_EXTRA_BODY`.
- **Observability.** Dashboard with spend, requests-by-model, token counts, TTFT, and a per-request log, grouped by project and by API key — exportable. Longer retention requires Observability Plus. A paid "Custom Reporting" add-on adds tags / user IDs and a reporting query endpoint.
- **Prompt caching pass-through.** `cache_control` is passed through to Anthropic (also Vertex/Bedrock Anthropic); OpenAI-style implicit caching works automatically. Cache usage fields (`cache_creation_input_tokens`, `cache_read_input_tokens`) come back in responses. This matters: Claude Code leans heavily on prompt caching, so routing through the gateway does not forfeit cache pricing.
- **Coding-agent support.** First-class recipes for [Claude Code](https://vercel.com/docs/ai-gateway/coding-agents/claude-code) (env vars only), [Codex CLI](https://vercel.com/docs/ai-gateway/coding-agents/openai-codex) (`~/.codex/config.toml` custom provider, `wire_api = "responses"`), and OpenCode (provider entry in `opencode.json`), among others.
- **Model discovery.** Unauthenticated `GET https://ai-gateway.vercel.sh/v1/models` returns the full catalog with pricing, context windows, and capability tags; `gateway.getAvailableModels()` in the AI SDK does the same.
- **Security/compliance options.** Prompt-training opt-out, and Zero Data Retention routing (per-request free; team-wide as a paid add-on).

## 3. Models available (grouped by vendor)

Snapshot from the live catalog on 2026-07-24: **308 models across 34 vendors** (language, embedding, image, video, reranking). Prices are USD per **1M tokens**, input/output, at provider list price.

| Vendor | Models | Notable language models (input / output per 1M) |
|---|---|---|
| **OpenAI** | 60 | gpt-5.5 ($5/$30), gpt-5.4 ($2.50/$15), gpt-5.4-mini ($0.75/$4.50), gpt-5.6-sol ($5/$30), gpt-5.6-terra ($2.50/$15), gpt-5.6-luna ($1/$6), gpt-5.3-codex ($1.75/$14), gpt-5.4-pro / gpt-5.5-pro ($30/$180), o-series, gpt-oss-120b ($0.10/$0.50) |
| **Alibaba** | 35 | Qwen family |
| **Google** | 30 | gemini-3.1-pro-preview ($2/$12), gemini-3.6-flash ($1.50/$7.50), gemini-3.5-flash ($1.50/$9), gemini-3.1-flash-lite ($0.25/$1.50), gemma-4 open models |
| **xAI** | 18 | grok-4.5 ($2/$6), grok-4.3 ($1.25/$2.50), grok-4.20 variants ($1.25/$2.50), grok-4.1-fast ($0.20/$0.50) |
| **Mistral** | 16 | Large/Medium/Codestral family |
| **Z.ai** | 15 | GLM family |
| **Anthropic** | 15 | claude-fable-5 ($10/$50), claude-sonnet-5 ($2/$10), claude-opus-4.8 ($5/$25), claude-opus-4.8-fast ($10/$50), claude-sonnet-4.6 ($3/$15), claude-haiku-4.5 ($1/$5) |
| **Voyage** | 12 | embeddings/reranking |
| **ByteDance** | 11 | Seed/Doubao family |
| **DeepSeek** | 8 | V3/R1 family |
| **Moonshot AI** | 7 | Kimi family |
| **Meta** | 6 | Llama family |
| **Others** | 75 | Nvidia, Cohere, Amazon (Nova), Perplexity (Sonar, web-search), Minimax, Kwaipilot, inception, morph, poolside, BFL/Recraft/KlingAI (image/video), etc. |

**Every model our experiments use today is available**, with a slug rename (dots instead of hyphens in versions):

| Today (direct) | Gateway slug | Price (in/out per 1M) |
|---|---|---|
| `claude-sonnet-4-6` (Claude Code default) | `anthropic/claude-sonnet-4.6` | $3 / $15 |
| `claude-opus-4-8` | `anthropic/claude-opus-4.8` | $5 / $25 |
| `claude-sonnet-5` | `anthropic/claude-sonnet-5` | $2 / $10 |
| `gpt-5.4` (Codex default) | `openai/gpt-5.4` | $2.50 / $15 |
| `gpt-5.6-sol` | `openai/gpt-5.6-sol` | $5 / $30 |
| `gpt-5.6` | `openai/gpt-5.6-terra` / `-sol` / `-luna` (no bare `openai/gpt-5.6` slug) | varies |
| `gpt-5.5` (judge, hardcoded) | `openai/gpt-5.5` | $5 / $30 |

The big unlock: vendors we have **no keys for today** (Google Gemini, xAI Grok, DeepSeek, Qwen, Kimi, GLM, Llama) become available for the eval matrix with zero new vendor accounts.

## 4. What we have today (baseline)

- **Two provider keys**, direct to provider: `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` (`.env` locally; GitHub Actions secrets written to `.env` in `eval-refresh.yml`).
- **Three harnesses** (`packages/core/src/eval-metadata.ts:55`): `claude-code` (CLI in Docker sandbox, key injected per-exec via `env`, `packages/core/src/agents/claude-code/runner.ts:64`), `codex` (CLI in sandbox, key piped into `codex login --with-api-key`, `packages/core/src/agents/codex/runner.ts:42`), and `ai-sdk` (in-process `generateText` with `@ai-sdk/anthropic` / `@ai-sdk/openai`, `packages/core/src/index.ts:600`).
- **Models chosen per experiment** in `experiments/*.ts`; single-key-per-runner assumption in `requireApiKey()` (`packages/core/src/agents/engine.ts:118`).
- **No base-URL/proxy override anywhere**, and **no token/cost tracking** — the Codex parser reads `usage` from `turn.completed` events but nothing is persisted; results carry no cost fields.
- Judge model hardcoded to `openai("gpt-5.5")` (`packages/core/src/index.ts:559`).

## 5. What a side-by-side integration would look like

Vercel's own eval harness (`@vercel/agent-eval`) is the proof of feasibility — it registers **both** direct and gateway variants of each agent (`claude-code` and `vercel-ai-gateway/claude-code`, etc.) and routes them like this:

- **Claude Code:** env-only — `ANTHROPIC_BASE_URL=https://ai-gateway.vercel.sh`, `ANTHROPIC_AUTH_TOKEN=<gateway key>`, `ANTHROPIC_API_KEY=""` (the empty string is required; Claude Code prefers `ANTHROPIC_API_KEY` if non-empty). Maps cleanly onto our existing per-exec `env` injection in the runner.
- **Codex:** write `~/.codex/config.toml` with a `[model_providers.vercel]` block (`base_url = "https://ai-gateway.vercel.sh/v1"`, `env_key = "AI_GATEWAY_API_KEY"`, `wire_api = "responses"`) and pass `AI_GATEWAY_API_KEY` into the sandbox. Model ids become gateway slugs (`openai/gpt-5.4`).
- **AI SDK agent / judge:** `createGateway({ apiKey: process.env.AI_GATEWAY_API_KEY })` (exported from the `ai` package / `@ai-sdk/gateway`), or plain `"anthropic/claude-sonnet-5"` strings, since the gateway is the AI SDK's default string-model provider.

In our codebase this is naturally a **third value of `apiKeyEnvVar` plus per-runner env/config deltas** — e.g. gateway-variant experiment files next to the existing ones, gated on `AI_GATEWAY_API_KEY` being set, leaving the direct path untouched. One extra CI secret.

Known gotchas from Vercel's implementation worth inheriting:
- Codex over a custom provider rejected `reasoning_effort=low` for `gpt-5.2-codex`, and codex ≥0.144.0 dropped its shell tool when a custom provider was set without an explicit `model` (they ship a "canary" repair for it). We pin Codex 0.138.0, which predates that regression, but it's a flag for future CLI bumps.
- If the gateway ever routes an Anthropic request to Bedrock/Vertex, Claude Code's beta headers can break; either set `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` or pin `providerOptions.gateway.only = ["anthropic"]` via `CLAUDE_CODE_EXTRA_BODY`.
- `@vercel/agent-eval` extracts **no cost/usage data from the gateway** either — they rely on the dashboard. If we want per-run cost in results, we'd still parse `usage` from CLI transcripts ourselves (the gateway doesn't change that) — but the dashboard gives spend-per-key/project for free.

## 6. Advantages vs. today

1. **One key and one billing surface for N vendors.** Today adding Gemini, Grok, DeepSeek, Qwen, or Kimi to the benchmark means a new vendor account, key, and CI secret each. With the gateway it's a new experiment file with a different slug.
2. **Spend/usage observability we currently lack entirely.** Per-key, per-project spend, tokens, TTFT, and request logs out of the box — our results today carry zero cost data. Separate named keys (e.g. `evals-ci`, `evals-local`) give clean attribution.
3. **Reliability for CI eval runs.** Automatic retry/failover across providers hosting the same model, plus explicit fallback lists — useful against provider incidents mid-fleet-run.
4. **Zero token markup, and BYOK keeps our existing billing if we want.** We can route through the gateway while still paying Anthropic/OpenAI directly with our keys.
5. **Low-risk, incremental adoption.** Env/config-only changes at exactly the seams our runners already have; direct path stays intact; proven pattern in `@vercel/agent-eval`.
6. **Prompt caching, token counting, thinking, and tool use all pass through** on the Anthropic surface, so Claude Code behavior and cache economics are preserved.
7. **Model discovery API** enables catalog/price checks in tooling (e.g. warning when an experiment's model slug disappears or reprices).

## 7. Disadvantages / risks vs. today

1. **A new single point of failure and ~20ms extra latency.** A gateway outage stalls *all* harnesses at once, where today an Anthropic outage leaves Codex runs unaffected. (Mitigated by keeping the direct path as fallback — which the side-by-side design gives us anyway.)
2. **Prepaid credits instead of provider invoices** (unless BYOK). Credits must be topped up (manual or auto top-up), and payment-processing fees are on us. Budgeting model changes from per-vendor postpaid to Vercel-prepaid.
3. **Rate limits are gateway-mediated.** Free tier is heavily limited (subset of models, per-model 429s); the paid tier raises limits but our effective throughput ceiling is Vercel's provider capacity, not our own provider tier. Our fleet fan-out is rate-shaped already, but this needs empirical validation before trusting big benchmark runs to it.
4. **Slug/behavior drift.** Model ids differ (`claude-opus-4-8` → `anthropic/claude-opus-4.8`; no bare `gpt-5.6` — it's `-sol`/`-terra`/`-luna`), typed model ids from `@anthropic-ai/sdk`/`openai` no longer apply, and new provider features can lag behind direct APIs (e.g. Codex WebSocket streaming is OpenAI-models-only; some reasoning params behave differently through the custom provider path).
5. **Data path through a third party.** Prompts/outputs transit Vercel. Prompt-training opt-out exists; per-request ZDR routing is free but restricts the provider pool; team-wide ZDR is a paid add-on ($0.10/1k requests). Fine for synthetic evals, worth stating explicitly.
6. **Observability is dashboard-first.** Rich programmatic reporting (tags, user IDs, query endpoint) is a paid add-on ($0.075/1k tag writes, $5/1k queries); without it we get dashboard + log export, not an API we can pipe into `eval-results.json`.
7. **Judge determinism caveat.** With failover enabled, "the same model" may be served by different infra providers (Anthropic vs. Bedrock vs. Vertex) with potentially different numerics; for the judge we'd want `only: ["openai"]`-style pinning.

## 8. Pricing impact

**Token costs: neutral by design.** The gateway charges provider list price with zero markup, both with Vercel-managed credentials and with BYOK. Anthropic prompt-cache pricing (cache reads/writes) passes through, so Claude Code's cache-heavy traffic costs the same as today. Spot-check against the live catalog confirmed our current models at expected list prices (Section 3).

What actually changes:

| Item | Today | Via gateway |
|---|---|---|
| Token spend | Anthropic + OpenAI invoices | Same list prices, deducted from prepaid AI Gateway Credits — or unchanged provider invoices with BYOK ($0 gateway fee) |
| New vendors (Google, xAI, …) | New account + key + invoice each | Same credits pool, no new accounts |
| Free allowance | none | Monthly free credits ($5/month per current third-party reporting; the [official pricing page](https://vercel.com/docs/ai-gateway/pricing) confirms the free tier but not the amount) on a model subset with low rate limits — enough for smoke-testing the integration, not for benchmark runs; lapses once credits are purchased |
| BYOK fallback | n/a | If our provider key fails, gateway retries with system credentials and bills those tokens to credits |
| Optional add-ons | n/a | Custom Reporting $0.075/1k tag writes + $5/1k queries; team-wide provider allowlist $0.10/1k requests; team-wide ZDR $0.10/1k requests (allowlist/ZDR are Pro/Enterprise features) |
| Payment processing fees | provider-dependent | on us, per top-up |

**Realistic expectation for our workload:** an eval refresh's model spend is unchanged; the only new costs are optional add-ons and whatever BYOK fallback traffic occurs. The decision is operational (credits + one more hop + Vercel in the data path) in exchange for multi-vendor access and spend observability — not a token-price decision.

## 9. Recommendation

Build the side-by-side path: a gateway variant of each harness behind `AI_GATEWAY_API_KEY`, starting with one gateway-routed experiment per harness in the `regression` suite to compare reliability, latency, and dashboard spend data against the direct path. Validate under fleet fan-out (rate limits) and across a CLI version bump (Codex custom-provider quirks) before deciding. BYOK our existing Anthropic/OpenAI keys so billing is unchanged during the trial; use Vercel-managed credentials only for net-new vendors (Gemini, Grok, …).

---

### Sources

- [AI Gateway overview](https://vercel.com/docs/ai-gateway) · [Pricing](https://vercel.com/docs/ai-gateway/pricing) · [Models & Providers](https://vercel.com/docs/ai-gateway/models-and-providers) · [BYOK](https://vercel.com/docs/ai-gateway/authentication-and-byok/byok) · [Anthropic Messages API](https://vercel.com/docs/ai-gateway/sdks-and-apis/anthropic-messages-api) · [Coding Agents](https://vercel.com/docs/ai-gateway/coding-agents) ([Claude Code](https://vercel.com/docs/ai-gateway/coding-agents/claude-code), [Codex](https://vercel.com/docs/ai-gateway/coding-agents/openai-codex), [OpenCode](https://vercel.com/docs/ai-gateway/coding-agents/opencode)) · [Observability](https://vercel.com/docs/ai-gateway/observability-and-spend/observability)
- Live model catalog: `GET https://ai-gateway.vercel.sh/v1/models` (2026-07-24 snapshot, 308 models)
- Reference implementation: `~/vercel-agent-eval/packages/agent-eval` (`src/lib/agents/shared.ts`, `claude-code/agent.ts`, `codex/agent.ts`, `opencode/agent.ts`, `classifier.ts`)
- This repo: `packages/core/src/agents/*`, `packages/core/src/index.ts`, `experiments/*.ts`, `.github/workflows/eval-refresh.yml`
