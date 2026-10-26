# Provider usage dashboard

An opt-in owner drop-in that gathers connected subscriptions and API providers in one mobile-friendly dashboard. It uses read-only usage requests, never a model generation. The dashboard is an artifact in the conversation, not a new global menu tile.

## Install and activate

1. Review the **complete source** in [examples/provider-usage.ts](examples/provider-usage.ts). It runs inside Pi Pocket with the owner's rights, outside tool-call approval checks.
2. Copy that file to the data folder's `extensions/provider-usage.ts` (normally `~/.pi-pocket/extensions/provider-usage.ts`). It starts disabled. The source imports this checkout's artifact implementation by absolute path; adjust that import and the `PocketHost` type import if your checkout is elsewhere. The extension folder's `node_modules` link supplies Pocket's dependencies.
3. The owner enables **provider-usage.ts** in **Menu → Extensions**. No server restart is needed.
4. Ask **“show provider usage”**: Pi publishes the dashboard in this conversation. **Menu → Artifacts → Provider usage** opens it again.
5. Ask again to refresh. Each call creates a new version of the same artifact ID, `provider-usage`, in that conversation. Old versions remain available.

It cannot be enabled by Pi itself. To stop it, turn it off in Menu → Extensions. Existing dashboard snapshots remain in the conversation.

## What it shows

| Provider/credential                         | Account information                                                                                                                                                                       |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anthropic OAuth                             | Available five-hour, seven-day, and model-scoped usage percentages and reset times; Extra Usage enabled/disabled when returned                                                            |
| Claude Code / `claude-bridge` login         | The same Claude account endpoint, using the local Claude Code OAuth credential                                                                                                            |
| OpenAI/Codex OAuth                          | Codex rate-limit windows, additional model-specific limits, plan and credit balance where returned; **not** ChatGPT web-message limits or OpenAI API spending                             |
| OpenAI "Sign in with ChatGPT" token sharing | No usage endpoint exists. Never sent anywhere; shows the limits from Pi's own latest request and when a request was last refused for a limit (such as "Subscription Sharing usage limit") |
| OpenRouter API key                          | This key's spending, daily/weekly/monthly usage, and configured spending limit/remaining allowance; **not** the whole account balance                                                     |
| Cursor API key (SDK)                        | Billed tokens, cost, and run count for the account's SDK cloud agents; **not** IDE usage                                                                                                  |
| Cursor Admin API key                        | Team spend, on-demand spend, fast premium requests, and billing-cycle start from the Admin API; requires a team admin key, not a user key                                                 |
| Gemini Bridge / Antigravity                 | Grouped weekly and five-hour quota windows for the Gemini pool and the separate Claude/GPT pool, one card per signed-in Antigravity account                                               |
| Mistral API key                             | No account usage endpoint exists. Shows the rate limits (tokens and requests per minute, per month when the plan has one) from Pi's own latest Mistral request, and Pi Pocket's spend     |
| GitHub Copilot OAuth                        | Quota percentages, reset date and unlimited markers for non-enterprise credentials                                                                                                        |
| Gemini, custom providers, other credentials | Listed as unavailable when no supported account endpoint exists, with any limits Pi's own requests saw; no guessed quota or percentage                                                    |

Provider inventory comes from Pi's `auth.json`, provider IDs in `models.json`, commonly used API-key environment variables, local Claude Code credentials, and providers recorded in this conversation's usage ledger. A custom provider configured only by a module, with no credentials or recorded session usage, cannot be discovered through the extension host and appears after it has recorded usage. Runtime-only credentials are not exposed by the host.

**Limits from Pi's requests.** Pi Pocket keeps the rate-limit headers of each provider's latest response to Pi's own model requests, and when a request was last refused for a limit (HTTP 429), in `provider-limits.json` in the data folder (only limit headers: never cookies, ids, or credentials). Where a provider's usage endpoint gives nothing (none exists, an expired login, a failed request), the card shows these instead, marked **From Pi's requests**, with the time of that request. They are a sample, not a live meter: they change with every request, and appear once Pi has used the provider since this feature was installed. Extension providers such as Claude Bridge are not instrumented.

The dashboard also shows per-provider token totals and estimated API cost from Pi Durable's usage ledgers: **all Pi Pocket sessions** (every conversation, subagents included, all time) and **this conversation**. Neither counts usage outside Pi Pocket, nor an account's subscription consumption. A $0 estimate does not guarantee no charges. Allowances may be shared across provider IDs or accounts; **do not add them together**.

## Privacy and safety

- Anyone who can steer Pi can request or refresh the dashboard, including guests invited to one session. Viewers can open existing snapshots but cannot ask Pi to fetch one. Account usage and all-session provider totals are shared with participants in the requesting conversation; keep this extension disabled if that information should remain owner-only.
- Reads Pi's provider auth/model files, Claude Code's `.credentials.json` (`CLAUDE_CONFIG_DIR` or `~/.claude`), the local CLIProxyAPI Antigravity credentials (`~/.local/share/cliproxyapi/auths/*.json`), and environment-key values. It does not change those files, refresh tokens, sign in, run configured key commands, read browser cookies, or inspect the SQLite database directly.
- Sends credentials only to fixed HTTPS endpoints: `api.anthropic.com/api/oauth/usage`, `chatgpt.com/backend-api/wham/usage`, `openrouter.ai/api/v1/key`, `api.github.com/copilot_internal/user`, `api.cursor.com`, and `daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary`. Redirects are rejected. Requests have a ten-second timeout and a bounded response size; the Cursor SDK applies its own read-only usage calls.
- Only normalized usage fields reach the artifact. Credentials, account IDs, raw responses, and raw network/JSON errors do not go to the model or dashboard. Tool results only identify where to open the dashboard.
- Does not enable Extra Usage, purchase credits, make model requests, change providers, or retry through paid credentials. Usage reads can still be rate-limited by the provider.
- Expired tokens show an explicit sign-in/refresh message. HTTP failures are isolated per provider; missing fields remain unknown, not zero. Providers can change these usage endpoints or reject a token's permissions.
- The HTML is self-contained and uses no CDN or external resources. It is a sandboxed **snapshot**: its refresh-help button explains how to ask Pi for a new version; it cannot access Pocket or credentials and does not poll.

## Offline verification

### Official Subscription usage extension: Claude Bridge option

The separate **Subscription usage** rail page from the official gallery also supports this machine's
Claude Bridge sign-in. Open it and choose **Claude sign-in → Claude Bridge (Claude Code)**. The existing
**Pi (Anthropic)** option remains the default. The selection is remembered in this browser; each source
has its own cached result.

This local addition is based on official `pocket-subscription-usage` v1.2.0, commit
`d350af8b0b96993d1d22cb4747db0e9471ae8836`. It reads Claude Code's `.credentials.json` from
`CLAUDE_CONFIG_DIR` or `~/.claude`, sends its token only to Anthropic's usage endpoint, and never sends
credentials to the browser. An expired sign-in needs refreshing in Claude Code with `claude auth login`;
this extension does not refresh or change credentials. OS keychain credentials are not supported.

The installed files are in `~/.pi-pocket/extensions/subscription-usage.ts` and
`~/.pi-pocket/extensions/subscription-usage/`. The v1.2.0 originals are backed up in
`~/.pi-pocket/backups/subscription-usage-2026-10-23-v1.2.0-original/`, and the previous patched
v1.1.0 in `~/.pi-pocket/backups/subscription-usage-2026-10-23-v1.1.0-claude-bridge/`.
The [local patch](examples/subscription-usage-claude-bridge.patch) preserves the customization against
the upstream version; an accepted gallery update can replace it. Gallery metadata stays unchanged
so Pocket can identify the local edits. After reviewing an update, reapply the compatible changes and
run `node --test test/subscription-usage-installed.ts` for offline server and phone-browser checks.
Set `SUBSCRIPTION_USAGE_EXTENSION_DIR` if the drop-in lives in a different extension folder.

### Provider usage dashboard checks

```sh
node --test test/provider-usage.test.ts test/provider-limits.test.ts test/docs-examples.test.ts
npm run check
npm run lint
npm test
```

Tests use fake credentials, responses and temporary Pocket data. They cover quota normalization, rate-limit headers from Pi's requests, all-session totals, empty/unlimited/error states, fixed read-only requests, credential redaction, expiration, command-valued keys, guest access, viewer submission restrictions, and updating one durable artifact. Live subscription access can be verified by anyone with steering rights after the owner activates the extension.
