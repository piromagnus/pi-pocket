# TODO — web-search gallery entry and DonSeTch coordination

State: DonSeTch is integrated as a provider (session 51416, validated live on 4.10.2).
Gallery PR open: TannerMidd/pi-pocket-extensions#23, source repo
piromagnus/pi-pocket-web-search @ ce4314b. Core PR TannerMidd/pi-pocket#126 closed
in its favour.

## Blocked on coordination (peyloride / TannerMidd)

- [ ] `web_search` / `web_crawl` are claimed by the `donsetch` gallery entry (first entry
      keeps the name), so PR #23 CI fails on those two claims until settled.
- [ ] Proposal sent in PR #23 (cc @peyloride): reduce their entry to its unique niche
      (`web_screenshot`, login/JS-render fetch) and free `web_search` / `web_crawl` for
      ours, since ours runs the same binary as a provider plus BYOK tiers/ledger/research.
      Alternative accepted: we rename our two tools if peyloride prefers keeping theirs.
- [ ] Renaming to avoid CI failure was rejected by the owner: not clean, and DonSeTch
      supports keys (`donsetch keys`), so ours is the superset story.

## After the name question settles

- [ ] If names stay ours: nothing to change (entry already validates whole against a
      pristine 0.20.0 with `scripts/validate.ts --local`).
- [ ] If we rename: update tools.ts, README, index.js, tests, push new commit, update
      entry (version, hashes) on the same PR.

## Later / open niche questions

- [ ] `web_screenshot` + PDF/OCR: still DonSeTch's unique tools — stays with their entry,
      or a separate small extension (no name conflicts). Out of scope here.
- [ ] After any DonSeTch major release (V5): rerun `test/donsetch.test.ts` + one live call;
      the CLI `--json` envelope is pinned in `web-search/donsetch.ts`.
