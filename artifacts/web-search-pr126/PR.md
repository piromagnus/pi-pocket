Title: Package web search as a standalone Pi Pocket extension

Provides an installable `web-search` extension for Pi Pocket 0.20.0+, using the experimental `host.fetchPublic` API. It exposes owner-only settings through public extension routes and a menu/launcher sheet, with its own stored keys and data under `host.dataDir`.

Search supports configurable quick/standard/deep provider ordering, manual overrides and fallback confined to the selected tier. Provider options cover Exa search/content and Tavily search, extraction, crawl and research. The local ledger tracks observed requests, outcomes and reported credits separately.

External tool output is defanged and fenced. The README documents installation, every contacted hostname and transmitted data, key isolation, experimental API requirements and accounting limits. Research creation remains non-replay-safe.

Validation: TypeScript, ESLint, formatting and 22 tests pass, including installation, owner/non-owner routes, disable cleanup, gallery manifest validation and public-network guards against unmodified Pi Pocket 0.20. Tests use fake provider responses. Chromium could not launch in this environment, so browser validation remains pending; no paid provider calls were made.
