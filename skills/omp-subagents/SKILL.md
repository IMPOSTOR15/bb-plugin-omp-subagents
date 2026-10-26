---
name: omp-subagents
description: "Inspect and steer the subagents of an OMP (acp-omp) thread: list the roster, read a subagent's transcript or final output, and message the OMP session from BB."
---

# OMP subagents

OMP subagents are not BB threads. OMP keeps their transcripts on the machine
under `~/.omp/agent/sessions/<workspace>/<timestamp>_<uuid>/<Agent>.jsonl`.
This plugin reads them through its host entry and exposes them in BB.

```
bb omp-subagents list [--json]                          sessions on every machine, with subagent counts
bb omp-subagents agents <thread-id> [--json]            roster: status, tools, tokens, cost, task
bb omp-subagents transcript <thread-id> <agent> [--json]
bb omp-subagents output <thread-id> <agent> [--json]    final artifact (.json preferred, else .md)
bb omp-subagents inject [--json] [--agent <id>] <thread-id> <message>
                                                        start a turn when idle, steer when running
```

- `<thread-id>` must be a BB thread whose provider is `acp-omp`.
- Agent ids are flat names (`ReviewAuth`, nested `Parent.Child`); anything with
  a path separator is rejected. Use the id from the roster: OMP renames a
  requested `Scout` to `Scout-2` when the name is taken.
- Statuses: `running` (transcript written in the last 90 s), `finished`,
  `failed` (last turn ended in an error), `interrupted` (killed), `partial`
  (no clean end and silent for 90 s: an orphaned agent).
- `--json` is a flag only before the positional arguments (or on its own for
  `list`/`agents`/`transcript`/`output`). For `inject`, everything after
  `<thread-id>` is the message, verbatim: a literal `--json` in it stays.
- `inject` talks to the OMP main agent. With `--agent <id>` it still goes to
  the main agent, but as an instruction to forward the message to that live
  subagent (`write agent://<id>`) instead of acting on it. Use the id from the
  roster, and only for an agent that is `running`.
- `list` covers every connected machine plus each machine that has an OMP
  thread, newest session first; a machine that cannot be reached is named on
  stderr and skipped.

## Agent tools

Inside a thread the same read paths are available as native tools, bounded to
20 000 characters (a cut says so, naming how much was shown):

- `omp_subagents_roster` `{ threadId? }` — the roster, like `agents`.
- `omp_subagent_read` `{ agentId, part?: "output" | "transcript", threadId? }` —
  one subagent's final output (default) or the newest part of its transcript.

`threadId` defaults to the current thread. There is no tool to inject; use the
CLI for that.
