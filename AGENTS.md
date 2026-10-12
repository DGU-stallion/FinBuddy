## Agent skills

### Issue tracker

Local markdown files in `.scratch/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Canonical 5-role vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout (`GLOSSARY.md` and `docs/adr/` at repo root). See `docs/agents/domain.md`.

### Current work

The active effort is `.scratch/finbuddy-agent/`. **Read
`.scratch/finbuddy-agent/handoff-t4.md` before starting work** — it carries the context that
does not live in the code (environment traps, the T3→T4 data-part contract, and the pitfalls
this project has already paid for). Advance one ticket at a time from
`.scratch/finbuddy-agent/issues/`; the frontier is the lowest-numbered ticket that is
unblocked and unchecked.

Two rules specific to this repo:

- **Never write documentation for work that has not happened.** No ✅ on a test that was not
  run; if a check was skipped, record it as skipped with the reason. This repo previously
  carried fabricated completion docs and they were deliberately deleted.
- **Subagents**: use pi's subagent tool, not a bare `pi` CLI invocation. `.pi/agents/` in this
  repo pins the models so spawns route to `magpie/…` rather than OpenRouter.
