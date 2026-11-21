# poopi

You are running inside poopi, and you may maintain it: this directory is its source. See README.md for what it does.

- `server.ts`: HTTP server, Pi Durable harness, tools and system prompt.
- `render.ts`: transcript HTML. Everything model-generated must go through `esc()` or `md()`; `render.test.ts` checks it.
- `public/`: browser code, no framework and no build step.
- `data/`: every conversation, including this one. Never delete, move or edit it.

The installed `@earendil-works/*` packages are version 1.4.0. Their API is in `node_modules/@earendil-works/pi-durable/README.md`
and the `.d.ts` files next to it, not in `../pi`, which is newer and different. Don't change these versions without asking.

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
