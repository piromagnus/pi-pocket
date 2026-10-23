---
title: gate-verifier entailment batch verdicts
author: Pmarrec
date: 2026-10-22
branch: main
touches:
    - AGENTS.md
    - docs-site/src/sidebar.mjs
    - docs/architecture.md
    - docs/auto-resume.md
    - docs/examples/provider-usage.ts
    - docs/extensions/policies/api-stability.md
    - docs/extensions/reference/host.md
    - docs/features.md
    - docs/index.md
    - docs/map.md
---

## Decided

Judge each claim/quote pair from the quote text alone. Allowed verdicts: entailed, partial, not_entailed, contradicted. For entailed, every number and statement in the claim must appear in the quote; a wrong number for the same comparison is contradicted. Write verdicts to the path the user names (here `/tmp/gate-demo/verifier-out/entailment-verdicts.jsonl`), with `verifier_model` and `verifier_agent` as instructed.

## Tried and ruled out

Do not use outside knowledge, web search, other run-folder files, or `verify_run.py`. Do not infer across pairs; mismatched claim/quote topics are not_entailed, not a pattern to invent.

## Watch out

User path can override the instructions' "run folder" output location. Empty `span` is fine for non-entailed; entailed needs a shortest exact quote substring of at least 15 characters. Final reply for this gate is one ASD-STE100 line: pair count and per-verdict counts.
