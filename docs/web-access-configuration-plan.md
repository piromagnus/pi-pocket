# Move Web access to the standalone extension

The standalone module in `extensions/web-search/` replaces the core Web access
implementation. For this installation, install its entrypoint as
`web-access.ts`. This keeps the existing enabled module identity across the
upgrade. It provides the same 5 tool names: `web_search`, `fetch_content`,
`web_crawl`, `web_research`, and `web_research_status`. It adds DonSeTch as an
optional provider. It keeps strict provider overrides and tier-bounded fallback.

## Install paths

Copy these repository paths into the Pi Pocket data directory:

- `extensions/web-search/web-search.ts` → `<PI_POCKET_DIR>/extensions/web-access.ts`
- `extensions/web-search/web-search/` → `<PI_POCKET_DIR>/extensions/web-search/`

`PI_POCKET_DIR` defaults to `~/.pi-pocket`. Do not copy tests or development
files. Before the upgrade, explicitly enable the existing `web-access.ts`
module through the current app API. The updated app uses the same filename and
preserves that enabled state. Do not install `web-search.ts` in this data
directory; it would create a second active module identity.

## Preserve settings and request history

The old core files are `web-search.json` and `web-usage.json`. Their source
folder is the parent of `PI_CODING_AGENT_DIR`, or `~/.pi` when that variable is
not set. The extension stores them under `<PI_POCKET_DIR>/web-search/`.

Back up the source files first. Copy each file only if its destination does not
exist. Keep the source files. Do not edit them or overwrite existing extension
data. The extension accepts the old flat and nested provider-key fields,
routing, tiers, extraction order, provider options, operations, usage counters,
and research handles. It also reads provider environment keys and the keys in
`<host.agentDir>/auth.json`; it does not display their values.

Example commands, run by the owner after review:

```sh
legacy_dir="${PI_CODING_AGENT_DIR:+$(dirname "$PI_CODING_AGENT_DIR")}"
legacy_dir="${legacy_dir:-$HOME/.pi}"
data_dir="${PI_POCKET_DIR:-$HOME/.pi-pocket}"
mkdir -p "$data_dir/extensions" "$data_dir/web-search"
cp -n /path/to/pi-pocket/extensions/web-search/web-search.ts "$data_dir/extensions/web-access.ts"
cp -Rn /path/to/pi-pocket/extensions/web-search/web-search "$data_dir/extensions/"
chmod 700 "$data_dir/web-search"
for file in web-search.json web-usage.json; do
    if [ -f "$legacy_dir/$file" ] && [ ! -e "$data_dir/web-search/$file" ]; then
        cp -p "$legacy_dir/$file" "$data_dir/web-search/$file"
        chmod 600 "$data_dir/web-search/$file"
    fi
done
```

Replace `/path/to/pi-pocket` with this checkout's path. `cp -n` and the
existence check prevent overwrites. Review the destination file names before
running the commands.

## Cut over

1. Back up the old settings and usage files, then copy them as above.
2. Before the upgrade, explicitly enable `web-access.ts` through the current
   app API:

    ```sh
    curl -f -X POST "$POCKET_URL/api/extensions/web-access.ts" \
        -H "Authorization: Bearer $OWNER_TOKEN" \
        -H "X-Pocket: 1" \
        -H "Content-Type: application/json" \
        --data '{"enabled":true}'
    ```

    Keep the owner token out of logs and shell history. The new drop-in uses the
    same filename, so the updated app preserves its enabled state after restart.

3. Install the aliased entrypoint and its `web-search/` assets. Do not edit live
   data during code checks.
4. Restart with the updated code. Check the owner-only settings page and all 5
   tool names. The browser module uses `pocket.api`, so its route follows the
   `web-access` module name. Do not run a paid provider test here.
5. Do not also install `web-search.ts`. Keep the old files and backup until the
   owner confirms the new module works.

The extension uses `host.fetchPublic` for all HTTP requests to external pages.
That upstream SSRF guard remains required. The module refuses to load when the
host does not provide it; there is no unrestricted-fetch fallback.
