# poopi

A small web UI for chatting with LLMs on [Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable).
Node serves everything: no framework, no build step, about 100 lines of browser JS.

## Run

```sh
npm ci
PI_EXTENSIONS=/home/flist/devel/kiro.ts/extensions/kiro.ts npm run serve   # http://127.0.0.1:8787
npm test       # markdown sanitizer tests
npm run check  # typecheck
```

`npm run serve` starts poopi again whenever it exits cleanly, which is how an agent restarts it (`kill -TERM`). Ctrl+C or a
crash ends it. On FreeBSD, `daemon -r` does the same job.

Agents have pi's `read`, `write`, `edit` and `bash` tools, running as your user in the directory poopi was started from.
The system prompt includes AGENTS.md files the way pi finds them (`~/.pi/agent/AGENTS.md`, then from `/` down to that
directory), so this repo's [AGENTS.md](AGENTS.md) tells an agent how to change poopi safely. Anyone who can reach the
port has a shell, so keep it on localhost.

Models and credentials come from pi: `~/.pi/agent/auth.json` (`/login`), `models.json`, provider environment variables such
as `KIRO_API_KEY`, and the default model from `settings.json`. Extensions in `~/.pi/agent/extensions/` and those listed in
`PI_EXTENSIONS` (comma-separated) are loaded, but only for the providers they register.

| Variable | Default | |
|---|---|---|
| `HOST` | `127.0.0.1` | Listen address |
| `PORT` | `8787` | |
| `DATA` | `./data` | Holds `poopi.sqlite`, all conversations |
| `ALLOWED_HOSTS` | | Extra `Host` header names, comma-separated (localhost is always allowed) |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | Where pi's auth and settings are read from |

There is no login. Reach it through an SSH tunnel: `ssh -L 8787:127.0.0.1:8787 beasty` (in a jail, use the jail's address
instead of `127.0.0.1` and set `HOST` to it).

## How it maps to pi

- **Sessions** (left sidebar) are Durable conversations. One SQLite file holds all of them.
- **Branches** (right sidebar) are Durable forks. Pressing *branch* on an answer continues from it. Pressing it on a
  question branches from just before that question and puts its text in the editor, like `/tree` does.
- Enter steers a busy run and Alt+Enter queues a follow-up, as in the TUI.
- The footer shows the branch's token totals and cost, plus context use from the last answer.
- Runs are durable: a run that a restart interrupts continues when the server starts again.
