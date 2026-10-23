---
title: Luo/MLReplicate eval citation qualifications
author: Pmarrec
date: 2026-10-23
branch: main
cost: { minutes: 25 }
touches:
  - Bibliothèque/raw/research-autonomous-scientists-20261023/C-evaluation/REPORT.md
---

## Decided
- In `arXiv:2509.08713v2`, the 55%→82% pitfall-detector numbers are from an LLM auditor (`gemini-2.5-flash-preview-05-20`, PDF p.18), not a human field replication. Some positive examples were injected (leakage into code; log updates; manual log performance edits, p.16–17). Cite only as LLM-auditor ablation on a partly synthetic set.
- In `arXiv:2605.16616v1`, manuscripts are scored without validating underlying experiments (p.9). CycleResearcher does not experiment or search literature (p.7); do not compare its cost with end-to-end systems as equivalent tasks.
- Keep the MLReplicate `59%` denominator conflict unresolved and non-citable (abstract/p.1 vs p.3 vs p.7 bases disagree). Prefer exact counts like `10/37`.

## Tried and ruled out
- Treating Luo detector accuracy as AI-scientist field success or human audit replication.
- Ranking systems by API cost when one system (CycleResearcher) is text-generation-only.
- Picking one base for the `59%` figure to make the paper look consistent.

## Watch out
- Re-check PDF page locators in the local audit text (`local-audit-2509…` / `2605…`) before survey wording; abstract bullets omit the auditor model and injection method.
- Separate benchmark scope (replication/reproducibility/tasks) from end-to-end discovery claims when drafting the French survey from `C-evaluation/`.
