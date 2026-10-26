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
  every agent of the thread as a tree (`Parent.Child` under `Parent`): status,
  agent type, model, tools, tokens, cost, a read-only marker, and its latest
  action. The header sums tokens and cost and filters by status. Tokens in
  count every prompt token, cached ones included (`input` + `cacheRead` +
  `cacheWrite`). Open an agent to read its transcript, its final output, or
  the patch of an isolated run; a failed agent shows its error.
- **Messaging.** A box at the bottom of the panel sends a message to the OMP
  session through BB: it starts a turn when the thread is idle and steers it
  when it is running. While an agent runs, its own panel has a box that asks
  the main agent to forward the message to that agent.
- **Status outside the thread.** The sidebar row of an OMP thread says how
  many subagents run or failed in the latest batch, and a toast reports an
  agent that fails, with a button that opens it.
- **Commands.** `Open OMP subagents` and `Open next running subagent` in the
  command palette, and `Open OMP subagents` in the thread actions menu.
- **An OMP sessions page** in the navigation rail, listing the OMP sessions on
  your machines with their subagent counts.
- **A CLI**, `bb omp-subagents`, with a skill that teaches agents to use it,
  and two read-only agent tools, `omp_subagents_roster` and
  `omp_subagent_read`.

Statuses are read from each transcript: `running` (written to in the last
90 s), `finished`, `failed` (last turn ended in an error), `interrupted`
(killed), and `partial` (no clean end, silent for 90 s).

## Requirements

- BB 0.47 or newer.
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
bb omp-subagents inject [--json] [--agent <id>] <thread-id> <message>
```

For `inject`, everything after `<thread-id>` is the message, verbatim.

## How it works

- `src/host.ts` runs in the BB host daemon on the machine that owns the files.
  It lists sessions, parses agent transcripts, and watches the session
  directory for changes. Every path is confined: `artifactsDir` must
  `realpath` to a session directory directly under the sessions root, agent
  ids are flat basenames, and artifacts are read only if they are regular
  files (a symlink out of the tree is not followed). Parsed transcripts are
  cached by path, mtime and size, so a refresh re-reads only changed files. A
  session's watch is released after 5 minutes without a roster read.
- `server.ts` maps a BB thread to its OMP session through the
  `thread/identity` event, caches the session directory, and relays host
  file-watch signals over BB realtime. A signal fires only for agent files
  (`.jsonl`, `.md`, `.json`, `.patch`).
- `src/roster-store.ts` is one roster per thread, shared by the chip, the
  panel and every strip: one request in flight, realtime refreshes for its own
  session only, and a fallback poll.
- `src/timeline.tsx` is a content script that mounts the strip under `task`
  rows. It finds a row's tool-call arguments through React fiber internals of
  BB's timeline, which is not a public API: a BB update can break the lookup.
  The failure mode is a missing strip, not a broken timeline.
- Agent ids come from the spawn result, because OMP renames a requested
  `Scout` to `Scout-2` when the name is taken.

## Limits

- Messages go to the OMP main agent. OMP has no external channel for steering
  one subagent: a message to an agent is a request that the main agent
  forwards. This plugin does not kill or revive agents.
- Updates come from file watching; the fallback poll is 10 s while an agent
  runs and 30 s after. A thread that is no longer on screen is polled only
  until its running agents settle.
- Only the newest 500 transcript entries are shown for a long agent.
- The agent tools reach an OMP session when it starts; a session that was
  already running sees them after a restart.
- The sidebar row status and the row menu's `Open OMP subagents` show in
  BB's own thread list. A thread list plugin that draws its own rows and menu
  (such as `bb-sidebar`) shows them only if it renders plugin row statuses
  and thread actions.

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
