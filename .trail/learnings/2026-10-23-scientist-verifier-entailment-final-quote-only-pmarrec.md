---
title: scientist-verifier entailment-final quote-only traps
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
For independent entailment batches (`ENTAILMENT-INSTRUCTIONS.md` + `entailment-input.jsonl`), judge each `claim`/`quote` pair from the quote alone. `entailed` needs every statement and number in the claim; put the shortest exact supporting substring (≥15 chars) in `span`. Wrong number on an otherwise matching claim is `contradicted`. Claim names a system or case the quote never names (e.g. CORE-Bench, ALIFE, ScienceAgentBench) while the rest matches → `partial`. Totally wrong quote topic → `not_entailed` with empty `span`. Write one JSON line per input `pair_id` to the run's `entailment-verdicts.jsonl` with `verifier_model` and `verifier_agent` (`entailment-final`).

## Tried and ruled out
Do not open other run-folder files, the research folder, the report, or `verify_run.py`. Do not search the web or use prior paper knowledge to “fix” a mismatched quote. Do not average or pattern-match across pairs (deliberate wrong pairs sit next to correct ones).

## Watch out
Same cost or campaign text can appear twice with one digit changed ($42 vs $49, 70 vs 77)—that is `contradicted`, not a typo to forgive. Literature-search claims paired with evaluation-protocol quotes are `not_entailed`. Subagent reply to the parent: ASD-STE100, file path, and verdict counts. Temp-only verdicts need no git commit of the learning unless the parent also committed repo work.
