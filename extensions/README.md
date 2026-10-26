# Local extensions

This directory keeps the owner's features separate from upstream Pi Pocket.

- **[Web search](web-search/README.md):** search, extraction, crawl, research, provider settings, and their browser UI.
- **Provider bridges (`provider-bridges/`):** Claude, Gemini, and Cursor adapters. They register through `host.registerModelProvider` and release resources through `web.onDispose`, without a custom module-loader protocol.
- **[Auto-resume](auto-resume/README.md):** the preserved, temporarily disabled continuation scheduler. Pi Pocket 0.21.0's native limit waiting is separate: it retries eligible provider requests before response content starts.
- **[SSH Sessions](ssh-sessions/README.md):** SSH transport, workspace configuration, and browser UI.

Use each package's installation instructions. Do not install a second copy of an already active module: duplicate tool or provider registrations can replace or conflict with the first copy.

## Remaining core integration

SSH workspaces still need environment selection, admission checks, and fail-closed handling in core. Provider usage still needs response-header observations and the current-working-directory host accessor.

These integration points stay in core because the upstream extension API cannot yet preserve those behaviors alone. Stored document kinds, credentials, and session data must not be renamed or reset when moving their implementation.
