# Local provider bridges

These standalone extensions use `host.registerModelProvider` and `web.onDispose`. They require Pi Pocket 0.20.0 or later. Install the dependencies from the Pi Pocket checkout before enabling them.

## Install the files

Copy the files into the data folder's flat `extensions/` directory. The default data folder is `~/.pi-pocket`; use `$PI_POCKET_DIR` when it is set.

```sh
EXTENSIONS="${PI_POCKET_DIR:-$HOME/.pi-pocket}/extensions"
mkdir -p "$EXTENSIONS/_claude-bridge-public"
cp extensions/provider-bridges/_claude-bridge-public/*.ts "$EXTENSIONS/_claude-bridge-public/"
cp extensions/provider-bridges/claude-bridge.ts "$EXTENSIONS/claude-bridge.ts"
cp extensions/provider-bridges/gemini-bridge.ts "$EXTENSIONS/gemini-bridge.ts"
cp extensions/provider-bridges/cursor-bridge.ts "$EXTENSIONS/cursor-bridge.ts"
cp extensions/provider-bridges/_cursor-bridge-limits.ts "$EXTENSIONS/_cursor-bridge-limits.ts"
```

The repository’s `_pocket.d.ts` shim is for local type checking only. Do not copy it: the app supplies its own `_pocket.d.ts` in the installed extension directory.

The installed layout is:

```text
~/.pi-pocket/extensions/
├── claude-bridge.ts
├── gemini-bridge.ts
├── cursor-bridge.ts
├── _cursor-bridge-limits.ts
└── _claude-bridge-public/
    ├── authentication.ts
    ├── catalogue.ts
    ├── limits.ts
    ├── module.ts
    ├── protocol.ts
    ├── provider.ts
    ├── upstream.ts
    └── worker.ts
```

Keep any existing `_claude-bridge/` folder as a legacy backup; the new entrypoint uses `_claude-bridge-public/` to avoid a stale helper cache. The owner turns each bridge on in **Menu → Extensions**. Claude uses the existing Claude Code sign-in. Gemini uses an existing, subscription-only local CLIProxyAPI. Cursor uses the existing Cursor SDK and credential in Pi's agent directory. The Cursor entrypoint locates that SDK with Pi's exported `getAgentDir()`; it does not install or modify the SDK.

Read [Claude Bridge](../../docs/claude-bridge.md) and [Gemini Bridge](../../docs/gemini-bridge.md) before activation. Keep the included license with copies of these files. No SDK or provider credentials belong in the Pocket extension directory.
