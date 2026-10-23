---
title: entailment claim-quote verdicts
author: Pmarrec
date: 2026-10-23
branch: main
touches:
  - AGENTS.md
  - README.md
  - docs-site/src/sidebar.mjs
  - docs/architecture.md
  - docs/auto-resume.md
  - docs/examples/provider-usage.ts
  - docs/extensions/browser-modules.md
  - docs/extensions/policies/api-stability.md
  - docs/extensions/reference/host.md
  - docs/extensions/reference/pocket.md
---

## Decided
Judge each claim-quote pair from the quote alone. Require every claim statement and number in the quote for `entailed`. Put `span` only for `entailed` (shortest supporting substring, ≥15 chars). Record `verifier_model` and `verifier_agent` on every line. Wrong benchmark names (e.g. MATH-507 vs MATH-500) are `contradicted` when the quote states a different identifier.

## Tried and ruled out
Do not treat paper/system attribution as entailed when the quote never names that system (e.g. AgentRxiv). Prefer `partial` when numbers and method rank match but the reporter name is absent. Do not use outside knowledge or other run-folder files.

## Watch out
Parallel pairs can differ by one wrong token; judge each line independently. Empty `span` for non-entailed verdicts. Output exactly one JSONL line per input `pair_id`.
