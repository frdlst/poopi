# poopi

You are running inside poopi, and you may maintain it: this directory is its source. See README.md for what it does.

- `server.ts`: HTTP server, Pi Durable harness, tools and system prompt.
- `extensions.ts`: loads and hot-reloads `extensions/`.
- `extensions/`: Durable extensions, see below.
- `render.ts`: transcript HTML. Everything model-generated must go through `esc()` or `md()`; `render.test.ts` checks it.
- `public/`: browser code, no framework and no build step.
- `data/`: every conversation, including this one. Never delete, move or edit it.

The installed `@earendil-works/*` packages are version 1.4.0. Their API is in `node_modules/@earendil-works/pi-durable/README.md`
and the `.d.ts` files next to it, not in `../pi`, which is newer and different. Don't change these versions without asking.

## Extensions and skills

To give agents new tools, prompt sections or hooks, add a file to `extensions/` whose default export is
`defineExtension({ name, tools, sections, hooks })` from `@earendil-works/pi-durable` (see its README, "Extensions" and
"Tools"). poopi loads it within a second, and every conversation uses it from its next request, with no restart.

- Put helper modules in a subdirectory: every top-level file must be an extension, and helpers are not reloaded.
- `npm run check` typechecks `extensions/` too. `curl -s localhost:${PORT:-8787}/api/extras` shows what loaded and
  each file's error. A file that fails to load keeps its last working version installed.
- Extensions run inside the poopi process: one that blocks or loops takes poopi down. Commit each one, as above.
- These are not pi extensions (`pi.registerTool`); pi's extensions only supply model providers here.

Skills are pi skills (`SKILL.md`), found where pi finds them: `~/.pi/agent/skills/`, `.pi/skills/` in this directory,
and pi packages. New ones show up on the next request.

## Changing poopi

1. Changes to `public/` are live on the next browser reload.
2. Before restarting for changes to `.ts` files, check that the server still works, because a server that fails to start
   takes this chat down until a human repairs it over SSH:
   ```sh
   npm run check && npm test && (PORT=8799 DATA=$(mktemp -d) timeout 8 node server.ts & sleep 6; curl -sf localhost:8799/api/models >/dev/null && echo SMOKE OK)
   ```
3. Commit the working change with git, one change per commit, so a human can revert it.
4. Restart with `kill -TERM $POOPI_PID` as the last command of your turn. Your run continues after the restart; that
   call shows as interrupted, which is expected.
