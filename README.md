# OMP Subagents for BB

See what the subagents of an [OMP](https://github.com/can1357/omp) thread are
doing, inside [BB](https://getbb.app).

BB draws each OMP `task` call as one opaque "Ran tool" row. OMP keeps a full
transcript for every subagent on disk; this plugin reads those files and puts
them where you are looking.

## What you get

- **A strip under every spawn.** Below each `task` row in the dialog, one line
  per agent: status glyph, name, and what it is doing now (current tool and
  intent while it runs, tool count after it settles). It stays after the
  agents finish. Click an agent to open its history in the side panel.
- **A roster panel.** The header chip `N subagents` opens a side panel with
  every agent of the thread: status, agent type, model, tools, tokens, cost,
  and its latest action. Open one to read its transcript or its final output.
- **Messaging.** A box at the bottom of the panel sends a message to the OMP
  session through BB: it starts a turn when the thread is idle and steers it
  when it is running.
- **An OMP sessions page** in the navigation rail, listing the OMP sessions on
  your machines with their subagent counts.
- **A CLI**, `bb omp-subagents`, with a skill that teaches agents to use it.

Statuses are read from each transcript: `running` (written to in the last
90 s), `finished`, `failed` (last turn ended in an error), `interrupted`
(killed), and `partial` (no clean end, silent for 90 s).

## Requirements

- BB 0.46 or newer.
- Threads on the `omp` provider (`acp-omp`). The `omp` CLI must run on the same
  machine as the thread's workspace; the plugin reads
  `~/.omp/agent/sessions` on that machine through BB's host daemon.

## Install

```sh
bb plugin install git:https://github.com/IMPOSTOR15/bb-plugin-omp-subagents.git
```

## CLI

```
bb omp-subagents list [--json]
bb omp-subagents agents <thread-id> [--json]
bb omp-subagents transcript <thread-id> <agent> [--json]
bb omp-subagents output <thread-id> <agent> [--json]
bb omp-subagents inject <thread-id> <message>
```

## How it works

- `src/host.ts` runs in the BB host daemon on the machine that owns the files.
  It lists sessions, parses agent transcripts, and watches the session
  directory for changes. Every path is confined: `artifactsDir` must
  `realpath` to a session directory directly under the sessions root, agent
  ids are flat basenames, and artifacts are read only if they are regular
  files (a symlink out of the tree is not followed).
- `server.ts` maps a BB thread to its OMP session through the
  `thread/identity` event and relays host file-watch signals over BB realtime.
- `src/timeline.tsx` is a content script that mounts the strip under `task`
  rows. It finds a row's tool-call arguments through React fiber internals of
  BB's timeline, which is not a public API: a BB update can break the lookup.
  The failure mode is a missing strip, not a broken timeline.
- Agent ids come from the spawn result, because OMP renames a requested
  `Scout` to `Scout-2` when the name is taken.

## Limits

- Messages go to the OMP main agent. OMP has no external channel for steering
  one subagent, and this plugin does not kill or revive agents.
- The strip refreshes by polling (4 s while an agent runs, 15 s after).
- Only the newest 500 transcript entries are shown for a long agent.

## Development

```sh
npm install
npm run typecheck
npm test
bb plugin build
bb plugin install .
```

## License

MIT
