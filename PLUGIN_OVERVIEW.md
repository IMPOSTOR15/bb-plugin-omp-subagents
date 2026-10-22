## What you get

BB draws each OMP `task` call as one opaque "Ran tool" row, while OMP keeps a
full transcript for every subagent on disk. This plugin reads those files and
shows them in BB.

- **A strip under every spawn.** Below each `task` row, one line per agent:
  status glyph, name, and what it is doing now. It stays after the agents
  finish, with each agent's final status and tool count. Click an agent to
  open its history in the side panel.
- **A roster panel.** The `N subagents` chip in the thread header opens every
  agent of the thread with its status, model, tools, tokens, cost, and latest
  action. Open an agent to read its transcript or final output.
- **Messaging.** A box at the bottom of the panel sends a message to the OMP
  session through BB: it starts a turn when the thread is idle and steers it
  when it is running.
- **An OMP sessions page** listing the OMP sessions on your machines with their
  subagent counts.
- **A `bb omp-subagents` command** and a skill, so an agent can read the same
  roster, transcripts, and outputs.

## How it works

The plugin reads `~/.omp/agent/sessions` on the machine that runs the thread
and watches it for changes. A status comes from each transcript: running,
finished, failed, interrupted, or partial for an agent that stopped without a
clean end.

## Requirements

- BB 0.46 or newer.
- Threads on the `omp` provider. The `omp` CLI must run on the same machine as
  the thread's workspace.

## Limits

- Messages go to the OMP main agent. OMP has no external channel for steering
  one subagent, and the plugin does not kill or revive agents.
- The strip finds a row's spawn data through BB's internal timeline code, which
  is not a public API. A BB update can remove the strip; the timeline itself is
  not affected.
