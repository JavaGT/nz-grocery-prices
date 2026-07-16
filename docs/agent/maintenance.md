# Agent System Maintenance — `nz-grocery-prices`

Update agent-facing docs/config **in the same change** when you touch any of:

- **commands, scripts, package manager, CI, or test runner behavior** — update
  `command-map.md` and `AGENTS.md` command tables.
- **repo structure, package names, service boundaries, or ownership** — update
  `project-map.md`.
- **environment variables, local services, ports, databases, or external APIs**
  — update `command-map.md` env tables and `project-map.md`.
- **canonical helpers, fixtures, adapters, test builders, or patterns** — update
  `verification.md` seams section.
- **opencode agents, permissions, prompts, `AGENTS.md`, or `opencode.json`** —
  update `AGENTS.md`.
- **known flaky/slow checks, debugging steps, or failure modes** — update
  `verification.md`.

## Before handoff, confirm

- `AGENTS.md` still points to the right files.
- Command examples in `command-map.md` still work (run them, or mark unverified).
- New behavior has a targeted verification path in `verification.md`.
- A fresh agent can understand the change without reading the entire PR history.
- `npm run check` and `npm test` pass.

## When NOT to update

Pure internal refactors that don't change commands, structure, ownership, env,
or verification paths need no doc update. When unsure, update — too-narrow is
harmless; a stale map is not.
