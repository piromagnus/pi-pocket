# Working on Pi Pocket

Pi Pocket is often edited from inside itself, while it runs. [docs/map.md](docs/map.md) says where things are, and [docs/architecture.md](docs/architecture.md) what they rely on. [docs/self-editing.md](docs/self-editing.md) has the whole of what follows, including how to check a change on a throwaway copy (`node test/serve.ts`); [docs/index.md](docs/index.md) lists every guide. Keep editing safe:

- `web/**` changes reload every open browser right away. Keep the app loadable after each save: a syntax error blanks the screen for everyone, including you. Check with `node --check web/<file>.js` after editing.
- `src/server/extensions/*.ts` changes are reinstalled into the running server. A file that fails to load keeps its previous version and reports the error. Each module default-exports `(host, web) => Extension | Extension[] | void`, possibly async (`web` adds routes and a browser module to the app: [docs/extensions/app.md](docs/extensions/app.md)). Start each module with a `/** … */` comment: its first sentence is the description in the app's Extensions sheet, where the owner can turn modules off (a module that is off is not loaded, even when edited).
- Other `src/server/**` changes need a restart (menu → Restart server). Running work resumes after it, but a tool call cut off mid-run that is not replay-safe comes back as interrupted. Do not restart while your own tool call is running; finish the edit, run `npm run check` and `npm test`, then ask the user to restart.
- The owner's drop-in extensions in `~/.pi-pocket/extensions/` load the same way, after the built-in ones, and stay off until the owner turns them on. A `node_modules` link there lets them import Pi Pocket's packages.
- Document kinds in `src/server/docs.ts` are stored data. Do not rename them, or change their scope, history, or fork settings: Pi Durable checks those against what is stored.
- The server is plain TypeScript run by Node's type stripping: only erasable syntax (no enums, no parameter properties, no namespaces). Imports use `.ts` extensions.
- Code style is Prettier (`.prettierrc.json`: 4 spaces, 100 columns) plus ESLint's layout rules (`eslint.config.js`): braces on every `if` and loop, and a blank line after declarations, around blocks, and before `return` and `throw`. Run `npm run format` after editing. Prettier leaves the markup in `html` templates alone, so lay it out by hand the same way: 4 spaces per level, and a tag that runs past 100 columns gets one attribute per line and its children on their own lines. In htm a line break is not a space: break only where there is no space, or between tags, never inside running text.
- Run `npm run check`, `npm run lint`, and `npm test` after server changes.

## Licensing and gallery attribution

- For new projects or extensions created for the owner, include a `LICENSE` file naming **Pierre Marrec** as the author/copyright holder. Preserve existing third-party licenses and copyright notices.
- When publishing a new extension to the gallery, set its author metadata to **Pierre Marrec**.

<!-- trail:start -->

## Trail — repo context graph

This repo is indexed in `.trail/cache/`: small linked markdown nodes that explain each
system and carry exact file:line spans, kept in sync with the code through `trail build`.
The `.trail/` directory stays local: it is gitignored, never committed or pushed (for now).

For ANY task here — understanding how something works, finding where code lives,
or scoping a change — get context from the graph before grepping or opening
source files. Re-ask freely (it's cheap) and reuse literal identifiers you
already have (symbol, error string, file name) as the query. New to this repo?
Run `trail map` first — a token-budgeted orientation (dir clusters, hubs,
hotspots), no LLM, no key.

- Run `trail ask "<your question>" --source` → ranked nodes with the relevant
  code spans inlined (each hit's ≤8-line crux by default; `--full` for whole
  definitions when the crux isn't enough). Match the tool to the task shape:
  for understanding or editing, the top node IS the answer — cite its
  `covers:` file:line spans and edit straight from `--source`. For
  exhaustive tasks ("every occurrence / every caller of this pattern"), ranked
  results are top-N, not complete — run `trail grep "<literal>"` instead
  (exhaustive over indexed files, grouped by enclosing symbol), falling back
  to raw `grep -rn` only for unindexed files.
- `trail skeleton <file>` → every definition's signature + span, ~10× cheaper
  than reading the file; use it to skim an API surface.
- `trail callers <symbol>` gives precomputed, exact edges — who calls this.
  Add `--direction out` for what it calls, or `--depth N` to walk
  transitively for the full blast radius. For structural questions, skip
  ranking and use this directly.
- Or browse: `.trail/cache/INDEX.md` lists every node; follow the links.
- Monorepos and folders of multiple repos rank fairly across sub-projects —
  hits carry `[scope/]` labels naming which one they're from. Narrow with
  `trail ask "<task>" --in <scope>/` once you know where you're working.

If a returned span is truncated ("+N more lines"), open the file at that exact
range before finalizing. Only open source files when a node genuinely lacks a
needed detail, and then at the exact file:line the node points to — never
re-read whole files.

After big code changes, refresh the graph with `trail build` (deterministic,
no API key, $0).
<!-- trail:end -->
