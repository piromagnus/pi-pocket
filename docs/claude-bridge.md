# Claude Code subscription provider

An **opt-in owner drop-in**, built from the reviewed `pi-claude-bridge@0.9.2` provider. It uses the machine's first-party Claude Code subscription login, not Pi's Anthropic API key. Selecting a `claude-bridge` model changes only that conversation; enabling the module makes those models available server-wide.

This is **not a billing guarantee**. Anthropic decides eligibility and quota. Before sending anything, disable **Extra Usage** in your Claude account if you need a spending backstop. The bridge does not change that account setting, bypass quota, retry via an API provider, or fall back to paid credentials.

## Install and activate

This standalone extension uses Pi Pocket's public `host.registerModelProvider` and `web.onDispose` APIs. The APIs require Pi Pocket 0.20.0 or later. Install the pinned dependencies in the Pi Pocket checkout.

1. Install dependencies with `npm install` in the Pi Pocket checkout.
2. Check Claude Code is available and subscription-authenticated: `claude auth status`. If needed, run `claude auth login` yourself. An API-key or gateway login is rejected.
3. Copy `extensions/provider-bridges/_claude-bridge-public/` into the data folder as `extensions/_claude-bridge-public/`. These helper files are not modules. They remain there across Pocket updates and need the pinned dependencies available through the extension folder's `node_modules` link. Leave any existing `extensions/_claude-bridge/` folder untouched as a legacy backup.
4. Copy `extensions/provider-bridges/claude-bridge.ts` into the data folder as `extensions/claude-bridge.ts`.

5. After checks pass, use **Menu → Restart server**. Then the owner enables **claude-bridge.ts** in **Menu → Extensions**. The drop-in starts off and does not sign in or make model requests by itself.
6. Open the session's model picker and select a `claude-bridge/…` model. Every listed bridge model is configured to request 1M context, including `claude-bridge/claude-haiku-5-5` (128K output metadata). Model labels say **1M requested**, not verified support: older models or unentitled subscriptions may reject the request.

`PI_POCKET_CLAUDE_EXECUTABLE` can name another Claude Code executable. Otherwise the adapter uses `claude` on the server's PATH. Changing server environment variables needs a restart.

The standalone entrypoint is [extensions/provider-bridges/claude-bridge.ts](../extensions/provider-bridges/claude-bridge.ts). It uses public provider registration and registers worker cleanup with `web.onDispose`.

## What runs with the owner's rights

The drop-in loads its helpers from the installed `_claude-bridge-public/` folder, compiles the pinned upstream TypeScript into a disposable temporary directory, and registers one provider through the public host API. The original Pi CLI factory, TUI integration, and AskClaude tool are never activated.

Each active conversation gets an isolated worker process with its own fixed working directory. Summaries and generated titles get separate, short-lived workers. Claude sees the conversation, all effective Pocket instructions, tool definitions, and tool results; these go to Anthropic. Login checks use `claude auth status` metadata without reading or logging token files. Workers use Claude Code's normal credential/session storage; they do not read or write Pocket's stored data directly.

Every actual tool call returns to Pi Durable. Its validation, approvals, plan-mode checks, replay rules, and durable commits remain in control. Claude's native tools, cloud MCP servers, local MCP configuration, user/project Claude settings and hooks, and auto-memory are not used on this path. Managed Claude Code policies still apply.

## Subscription-only precautions

- Reject `ANTHROPIC_*` and known Claude credential/backend override environment variables. Errors name variables, never their values.
- Require a first-party `claude.ai` login both when enabling and before each worker request.
- Never use an API key, Bedrock/Vertex/Foundry backend, user/project `apiKeyHelper`, or automatic paid-provider fallback.
- Keep Pro-plan settings and `longContextExtraUsage: false`. At the owner's request, every listed model has a **requested** 1M ceiling, even if its catalog advertises less. The worker explicitly requests `<model-id>[1m]` for generation and isolated summaries; this is not merely UI metadata. A deliberately narrowed 200K request uses the bare ID. Unlisted models and overrides above 1M are rejected. Fable models and dated aliases are not listed. A 1M label is not proof that the model supports 1M or that the subscription is entitled: an unsupported request stays an error, with no automatic paid-provider or 200K fallback.

The installed pi-ai/upstream catalogs predate Haiku 5.5, so its entry is supplied from [Anthropic's published specifications](https://platform.claude.com/docs/en/about-claude/models/overview) until the catalog includes it. Haiku 5.5 has documented 1M capability; setting the same requested ceiling for other models does not give them that capability. 1M is not a universal Extra Usage requirement or a promise of subscription eligibility. Sending more context consumes more quota. These checks do not override Anthropic's billing decisions; disable Extra Usage account-side before making a real request.

- Preserve upstream's prompt rejection checks. Pocket's entire effective system prompt is captured and forwarded, without deleting or rewording safety instructions to get past a rejection. A rejected prompt fails before a model call, including on the isolated summary path.
- Zero-dollar bridge metadata only means Pocket has no per-token price for subscription usage. It does **not** prove that Anthropic will not charge you. Subscription usage, cache misses, titles, and compaction all consume your allowance.

## Durability and lifecycle

Pi Durable's transcript and provider session ID remain authoritative. SDK query handlers and worker processes are deliberately ephemeral: after a crash/restart, the next attempt reconstructs Claude's mirror from committed history, including already-completed tool results. Forks use independent provider identities and working directories. Switching a session's folder replaces its worker; process-wide `chdir()` is never used.

Disabling, reloading, removing, or shutting down the module unregisters its provider and closes its workers. Failed initialization closes staged workers before the loader reports failure. Sessions that selected a disabled provider keep their model selection but cannot call it until it is enabled again. An idle parked worker is reaped after 15 minutes and can rebuild later from the durable transcript. Rebuilds can lose prompt-cache hits and resend history.

Dependencies are pinned and the adapter checks the exact upstream version and source boundaries. Upgrading the bridge requires reviewing the adapter and rerunning its offline tests. No real Claude calls are part of the automated test suite. Request-instrumentation callbacks cannot cross this worker boundary and are rejected rather than silently omitted.

## Verify without spending quota

```sh
node --test test/claude-bridge.test.ts test/model-providers.test.ts
npm run check
npm run lint
npm test
```

Tests use fake login checks and fake SDK/IPC responses on throwaway data. Live subscription eligibility cannot be established by these tests; a real request should only be made after activation and the account-side spending backstop is in place.
