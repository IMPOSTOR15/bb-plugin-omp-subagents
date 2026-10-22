---
name: omp-subagents
description: "Inspect and steer the subagents of an OMP (acp-omp) thread: list the roster, read a subagent's transcript or final output, and message the OMP session from BB."
---

# OMP subagents

OMP subagents are not BB threads. OMP keeps their transcripts on the machine
under `~/.omp/agent/sessions/<workspace>/<timestamp>_<uuid>/<Agent>.jsonl`.
This plugin reads them through its host entry and exposes them in BB.

```
bb omp-subagents list [--json]                          machine sessions with subagent counts
bb omp-subagents agents <thread-id> [--json]            roster: status, tools, tokens, cost, task
bb omp-subagents transcript <thread-id> <agent> [--json]
bb omp-subagents output <thread-id> <agent> [--json]    final artifact (.json preferred, else .md)
bb omp-subagents inject <thread-id> <message>           start a turn when idle, steer when running
```

- `<thread-id>` must be a BB thread whose provider is `acp-omp`.
- Agent ids are flat names (`ReviewAuth`, nested `Parent.Child`); anything with
  a path separator is rejected. Use the id from the roster: OMP renames a
  requested `Scout` to `Scout-2` when the name is taken.
- Statuses: `running` (transcript written in the last 90 s), `finished`,
  `failed` (last turn ended in an error), `interrupted` (killed), `partial`
  (no clean end and silent for 90 s: an orphaned agent).
- `inject` talks to the OMP main agent, not to an individual subagent.
