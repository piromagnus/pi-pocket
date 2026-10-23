---
title: Independent claim-quote entailment verdicts
author: Pmarrec
date: 2026-10-23
branch: main
touches:
  - AGENTS.md
  - docs-site/src/sidebar.mjs
  - docs/architecture.md
  - docs/auto-resume.md
  - docs/examples/provider-usage.ts
  - docs/extensions/browser-modules.md
  - docs/extensions/policies/api-stability.md
  - docs/extensions/reference/host.md
  - docs/extensions/reference/pocket.md
  - docs/features.md
---

## Decided
For scientist-verifier claim/quote pairs, judge each line from the quote alone: every claim number and clause must appear (or follow by trivial arithmetic). Use `entailed` only when all parts match; use `partial` when the quote supports the core but omits an extra clause (e.g. “not experimental replication”, “API ≠ full cost”, “LLM-based”, “Sakana”, “excluding human labor”); use `contradicted` for an incompatible figure (64% vs 57%); use `not_entailed` when the quote is unrelated. Write one JSONL object per `pair_id` with `verifier_model`/`verifier_agent`, and for `entailed` a contiguous `span` ≥15 chars that covers the full claim.

## Tried and ruled out
Do not search, read other run-folder files, or run `verify_run.py`. Do not soft-entail inferences that the quote never states. Do not treat a short span that covers only one clause as enough for a multi-part claim.

## Watch out
Same claim text can pair with different quotes (correct % vs wrong %). Seed relaunches attributed to humans are often system-autonomous in the quote. Apostrophes in spans must match the quote’s exact Unicode.
