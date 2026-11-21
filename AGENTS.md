# poopi

A web chat on Pi Durable; see README.md for what it does and how to run it.

- `server.ts`: HTTP server, Pi Durable harness, tools and system prompt.
- `extensions.ts`: loads and hot-reloads `extensions/`.
- `extensions/`: Durable extensions, see below.
- `render.ts`: transcript HTML. Everything model-generated must go through `esc()` or `md()`; `render.test.ts` checks it.
- `public/`: browser code, no framework and no build step.
- `data/`: every conversation. Never delete, move or edit it.

The installed `@earendil-works/*` packages are version 1.4.0. Their API is in `node_modules/@earendil-works/pi-durable/README.md`
and the `.d.ts` files next to it; the pi repository's main branch is newer and different. Don't change these versions
without asking: newer ones upgrade `data/` so that 1.4.0 can no longer read it.

Check changes with `npm run check && npm test`. A smoke start that leaves `data/` alone:

```sh
(PORT=8799 DATA=$(mktemp -d) timeout 8 node server.ts & sleep 6; curl -sf localhost:8799/api/models >/dev/null && echo SMOKE OK)
```

## Extensions and skills

To add tools, prompt sections or hooks, add a file to `extensions/` whose default export is
`defineExtension({ name, tools, sections, hooks })` from `@earendil-works/pi-durable` (see its README, "Extensions" and
"Tools"). A running poopi loads it within a second, and every conversation uses it from its next request.

- Put helper modules in a subdirectory: every top-level file must be an extension, and helpers are not reloaded.
- `npm run check` typechecks `extensions/` too. `GET /api/extras` shows what loaded and each file's error.
- Extensions run inside the poopi process: one that blocks or loops takes poopi down.
- These are not pi extensions (`pi.registerTool`); pi's extensions only supply model providers here.

Skills are pi skills (`SKILL.md`), found where pi finds them: `~/.pi/agent/skills/`, `.pi/skills/` in poopi's working
directory, and pi packages. New ones show up on the next request.
