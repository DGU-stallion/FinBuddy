## Agent skills

### Issue tracker

Local markdown files in `.scratch/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Canonical 5-role vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout (`GLOSSARY.md` and `docs/adr/` at repo root). See `docs/agents/domain.md`.

### Current work

The build is **complete and delivered**. All five tickets in `.scratch/finbuddy-agent/issues/`
(T1..T5) are done; there is no frontier to advance.

Delivered state (verified 2026-10-13, see `README.md` 「测试与验证」 and `TESTING.md`):

- `npx vitest run` → **46 files / 557 passed / 0 skipped**
- `npx tsc --noEmit` clean · `npm run lint` clean · `npm run build` compiled
- `node scripts/compliance-suite.mjs` → **6/6, exit 0** (dev server on :3000)

Orientation for a new session:

- **`README.md`** — the delivered product doc (users, workflow, design, AI role, data, boundaries).
- **`AI-USAGE.md`** — what AI did, where it went wrong, how it was caught. The richest record here.
- **`.scratch/finbuddy-agent/spec.md`** — the product spec and interaction decisions.
- **`.scratch/finbuddy-agent/issues/`** — per-ticket records (each carries its own findings).
- **`docs/adr/0001`、`0002`** — the hard decisions (guardrails, compliance, evidence integrity).
- **`.scratch/finbuddy-agent/handoff-t4.md`** — environment traps and paid-for pitfalls, worth
  reading before touching the data-part contract or re-running anything against live services.

There is no open work ticket. If you pick this up, the honest list of gaps is in
`README.md` 「失败条件与后续验证计划」 and `AI-USAGE.md` §6「未验证/待补」.

Two rules specific to this repo:

- **Never write documentation for work that has not happened.** No ✅ on a test that was not
  run; if a check was skipped, record it as skipped with the reason. This repo previously
  carried fabricated completion docs and they were deliberately deleted.
- **Subagents**: use pi's subagent tool, not a bare `pi` CLI invocation. `.pi/agents/` in this
  repo pins the models so spawns route to `magpie/…` rather than OpenRouter.
