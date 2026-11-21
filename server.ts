import { mkdir, readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { type AssistantMessage, getSupportedThinkingLevels, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
	DefaultResourceLoader,
	discoverAndLoadExtensions,
	formatSkillsForPrompt,
	getAgentDir,
	loadProjectContextFiles,
	ModelRuntime,
	stripFrontmatter,
} from "@earendil-works/pi-coding-agent";
import {
	type AgentChange,
	ConversationBusy,
	type ConversationId,
	type ConversationView,
	createRegistry,
	defineExtension,
	type EntryRecord,
	type EntryId,
	Harness,
	type InboxState,
	type LiveState,
	section,
	type UsageState,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { watchExtensions } from "./extensions.ts";
import { renderEntry, renderLive, titleOf } from "./render.ts";

const { HOST = "127.0.0.1", PORT = "8787", DATA = "data" } = process.env;
// Host header allow-list against DNS rebinding; the browser always sends this, also through an SSH tunnel.
const allowedHosts = new Set(["localhost", "127.0.0.1", "[::1]", ...(process.env.ALLOWED_HOSTS?.split(",") ?? [])]);

// Same providers and credentials as the pi CLI: auth.json, models.json, and extensions that register providers.
const agentDir = getAgentDir();
const piSettings = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8").catch(() => "{}"));
const models = await ModelRuntime.create({
	authPath: join(agentDir, "auth.json"),
	modelsPath: join(agentDir, "models.json"),
});
const extensions = await discoverAndLoadExtensions(process.env.PI_EXTENSIONS?.split(",") ?? [], process.cwd(), agentDir);
for (const { path, error } of extensions.errors) console.error(`extension ${path}: ${error}`);
for (const { name, config } of extensions.runtime.pendingProviderRegistrations) models.registerProvider(name, config);
for (const { provider } of extensions.runtime.pendingNativeProviderRegistrations) models.registerNativeProvider(provider);
await models.refresh({ allowNetwork: false });

// Tools and the system prompt. Agents work in the directory poopi was started from, unless a conversation sets `cwd`.
const workdir = process.cwd();
// Skills from the same places as pi: ~/.pi/agent/skills, .pi/skills, and pi packages in settings.json. Reading them
// again for every request (about 2 ms) picks up new and changed skills without a restart.
const skillLoader = new DefaultResourceLoader({
	cwd: workdir,
	agentDir,
	noExtensions: true,
	noPromptTemplates: true,
	noThemes: true,
	noContextFiles: true,
});
async function skills() {
	await skillLoader.reload();
	return skillLoader.getSkills().skills;
}
// `/skill:name args` sends the skill's text with the message, as pi does.
async function expandSkill(text: string): Promise<string> {
	const match = /^\/skill:(\S+)\s*([\s\S]*)$/.exec(text);
	const skill = match && (await skills()).find((s) => s.name === match[1]);
	if (!match || !skill) return text;
	const body = stripFrontmatter(await readFile(skill.filePath, "utf8")).trim();
	const block = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
	return match[2].trim() ? `${block}\n\n${match[2].trim()}` : block;
}

const registry = createRegistry();
registry.install(CodingTools);
registry.install(
	defineExtension({
		name: "poopi",
		sections: [
			section(
				"preamble",
				() =>
					"You are a coding agent in poopi, a web chat built on Pi Durable. Use your tools to read, change and run things. Be concise.",
				{ tag: false },
			),
			// Same AGENTS.md / CLAUDE.md discovery as pi: the agent dir, then every directory from / down to the cwd.
			section("project_context", ({ agent }) => {
				const files = loadProjectContextFiles({ cwd: agent.cwd ?? workdir, agentDir });
				const rendered = files.map((f) => `<project_instructions path="${f.path}">\n${f.content}\n</project_instructions>`);
				return files.length ? rendered.join("\n\n") : undefined;
			}),
			section("skills", async () => formatSkillsForPrompt(await skills(), "read").trim() || undefined),
			section("cwd", ({ agent }) => agent.cwd ?? workdir),
		],
	}),
);
// Agents' own Durable extensions, installed before the harness resumes so their pending tasks find their code.
const extensionStatus = await watchExtensions(registry, join(import.meta.dirname, "extensions"), ["coding-tools", "poopi"]);
// POOPI_PID lets an agent restart poopi (see AGENTS.md); the git identity marks commits as the agent's.
const shellEnv = {
	POOPI_PID: String(process.pid),
	GIT_AUTHOR_NAME: "poopi",
	GIT_AUTHOR_EMAIL: "poopi@localhost",
	GIT_COMMITTER_NAME: "poopi",
	GIT_COMMITTER_EMAIL: "poopi@localhost",
};

await mkdir(DATA, { recursive: true });
const harness = await Harness.open(
	await openNodeSqliteStorage(join(DATA, "poopi.sqlite")),
	{
		models,
		registry,
		env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? workdir, shellEnv }),
		// pi's compaction settings have the same shape, so the CLI's per-model overrides apply here too.
		settings: { compaction: piSettings.compaction },
		onReport: (error, info) => console.error(info.type, error),
	},
	ctx,
);
void harness.closed.then((end) => {
	if (end.reason === "failed") {
		console.error("harness failed", end.error);
		process.exit(1);
	}
});
harness.resume();

class HttpError extends Error {
	status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

type Body = Record<string, unknown>;

function agentChange(body: Body): AgentChange {
	const model = models.getModel(String(body.provider), String(body.modelId));
	if (model === undefined) throw new HttpError(400, "Unknown model");
	const thinkingLevel = body.thinkingLevel as ModelThinkingLevel;
	if (!getSupportedThinkingLevels(model).includes(thinkingLevel)) throw new HttpError(400, "Unsupported effort");
	return { model: { provider: model.provider, modelId: model.id }, thinkingLevel };
}

function text(body: Body): string {
	if (typeof body.text !== "string" || body.text.trim() === "") throw new HttpError(400, "Empty message");
	return body.text;
}

async function readJson(req: IncomingMessage): Promise<Body> {
	if (!req.headers["content-type"]?.startsWith("application/json")) throw new HttpError(415, "Expected JSON");
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req as AsyncIterable<Buffer>) {
		size += chunk.length;
		if (size > 1 << 20) throw new HttpError(413, "Body too large");
		chunks.push(chunk);
	}
	try {
		const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		if (typeof value === "object" && value !== null) return value;
	} catch {}
	throw new HttpError(400, "Invalid JSON");
}

const k = (n: number) => (n < 1000 ? `${n}` : n < 1e6 ? `${+(n / 1e3).toFixed(1)}k` : `${+(n / 1e6).toFixed(1)}M`);

/** Everything below the transcript: live answer, queue, footer and selected agent. */
function viewState(view: ConversationView) {
	const live = (view.docs["pi.live"] ?? {}) as LiveState;
	const agent = (view.docs["pi.agent"] ?? {}) as { model?: { provider: string; modelId: string }; thinkingLevel?: string };
	const usage = Object.values((view.docs["pi.usage"] as UsageState | undefined)?.models ?? {});
	const sum = (pick: (u: (typeof usage)[number]) => number) => usage.reduce((total, u) => total + pick(u), 0);
	const lastAnswer = view.entries
		.map((e) => (e.kind === "pi.assistant" ? (e.model?.[0] as AssistantMessage) : undefined))
		.findLast((m) => m !== undefined && m.usage.totalTokens > 0);
	const window = agent.model && models.getModel(agent.model.provider, agent.model.modelId)?.contextWindow;
	const context = window ? ` ${(((lastAnswer?.usage.totalTokens ?? 0) / window) * 100).toFixed(1)}%/${k(window)}` : "";
	return {
		busy: live.run !== undefined,
		live: renderLive(live, view.docs["pi.inbox"] as InboxState | undefined),
		agent: { provider: agent.model?.provider, modelId: agent.model?.modelId, thinkingLevel: agent.thinkingLevel ?? "off" },
		stats: `↑${k(sum((u) => u.input))} ↓${k(sum((u) => u.output))}${sum((u) => u.cacheRead) ? ` R${k(sum((u) => u.cacheRead))}` : ""}${sum((u) => u.cacheWrite) ? ` W${k(sum((u) => u.cacheWrite))}` : ""} $${sum((u) => u.cost.total).toFixed(3)}${context}`,
	};
}

/** Server-sent events: the transcript as HTML (whole on connect, then appends), and the state after every commit. */
async function events(req: IncomingMessage, res: ServerResponse, id: ConversationId) {
	const conversation = await harness.conversation(id, ctx);
	if (conversation === undefined) throw new HttpError(404, "No such conversation");
	// The view holds only the active transcript (from the last compaction), so the full history comes from a scan first.
	// shortcut: the whole history is sent on every connect, page it with "load earlier" if long conversations get slow.
	const history: EntryRecord[] = [];
	let cursor;
	do {
		const page = await conversation.entries({ order: "ascending" }, 500, cursor, ctx);
		history.push(...page.items);
		cursor = page.next;
	} while (cursor !== undefined);
	const watch = await conversation.watch(ctx);
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	const write = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
	write("entries", { reset: true, html: history.map(renderEntry).join("") });
	let last: number = history.at(-1)?.id ?? 0;
	const send = (view: ConversationView) => {
		const fresh = view.entries.filter((e) => e.id > last);
		if (fresh.length > 0) write("entries", { reset: false, html: fresh.map(renderEntry).join("") });
		last = fresh.at(-1)?.id ?? last;
		write("state", viewState(view));
	};
	send(watch.value);
	watch.start(async (view) => send(view));
	// Keeps SSH tunnels and proxies from dropping an idle stream.
	const ping = setInterval(() => res.write(": ping\n\n"), 30_000);
	req.on("close", () => {
		clearInterval(ping);
		void watch.stop();
	});
}

async function listConversations() {
	return harness.commit(async (tx) => {
		const list: { id: ConversationId; parent?: ConversationId; title?: string }[] = [];
		let cursor;
		do {
			const page = await tx.scanConversations({}, 256, cursor);
			for (const c of page.items) {
				if (c.owner !== undefined) continue;
				// shortcut: one entry scan per conversation for its title, store titles in a document if the list gets long.
				const minEntryId = c.parent && ((c.parent.at + 1) as EntryId);
				const own = await tx.scanEntries({ conversationId: c.id, minEntryId, order: "ascending" }, 10);
				list.push({ id: c.id, parent: c.parent?.conversationId, title: titleOf(own.items) });
			}
			cursor = page.next;
		} while (cursor !== undefined);
		return list;
	}, ctx);
}

const asset = (specifier: string) => fileURLToPath(import.meta.resolve(specifier));
const files: Record<string, [string, string]> = {
	"/": [join(import.meta.dirname, "public/index.html"), "text/html"],
	"/app.js": [join(import.meta.dirname, "public/app.js"), "text/javascript"],
	"/style.css": [join(import.meta.dirname, "public/style.css"), "text/css"],
	"/hljs-light.css": [asset("highlight.js/styles/github.css"), "text/css"],
	"/hljs-dark.css": [asset("highlight.js/styles/github-dark.css"), "text/css"],
};

async function route(req: IncomingMessage, res: ServerResponse): Promise<unknown> {
	const host = (req.headers.host ?? "").replace(/:\d+$/, "");
	if (!allowedHosts.has(host)) throw new HttpError(403, `Host ${host} not allowed, see ALLOWED_HOSTS`);
	const { pathname } = new URL(req.url ?? "/", "http://localhost");
	const file = files[pathname];
	if (req.method === "GET" && file) {
		res.writeHead(200, { "content-type": `${file[1]}; charset=utf-8` }).end(await readFile(file[0]));
		return;
	}
	if (req.method === "GET" && pathname === "/api/models") {
		const available = await models.getAvailable();
		return {
			models: available.map((m) => ({ provider: m.provider, id: m.id, name: m.name, levels: getSupportedThinkingLevels(m) })),
			default: {
				provider: piSettings.defaultProvider,
				modelId: piSettings.defaultModel,
				thinkingLevel: piSettings.defaultThinkingLevel,
			},
		};
	}
	if (req.method === "GET" && pathname === "/api/conversations") return listConversations();
	if (req.method === "GET" && pathname === "/api/extras") {
		const list = (await skills()).map((s) => ({ name: s.name, description: s.description }));
		return { skills: list, extensions: extensionStatus() };
	}
	if (req.method === "POST" && pathname === "/api/conversations") {
		const body = await readJson(req);
		const conversation = await harness.createConversation(
			{ ownership: { kind: "ownerless" }, agent: agentChange(body) },
			ctx,
		);
		await conversation.submit({ type: "input", content: await expandSkill(text(body)) }, ctx);
		return { id: conversation.id };
	}
	const match = /^\/api\/c\/(\d+)\/(\w+)$/.exec(pathname);
	if (match === null) throw new HttpError(404, "Not found");
	const id = Number(match[1]) as ConversationId;
	if (req.method === "GET" && match[2] === "events") return events(req, res, id);
	if (req.method !== "POST") throw new HttpError(405, "Method not allowed");
	const body = await readJson(req);
	const conversation = await harness.conversation(id, ctx);
	if (conversation === undefined) throw new HttpError(404, "No such conversation");
	switch (match[2]) {
		case "submit": {
			const whenBusy = body.mode === "followUp" ? "followUp" : "steer";
			await conversation.submit({ type: "input", content: await expandSkill(text(body)), whenBusy }, ctx);
			return {};
		}
		case "agent":
			await conversation.configure(agentChange(body), ctx);
			return {};
		case "fork": {
			if (!Number.isSafeInteger(body.at)) throw new HttpError(400, "Invalid entry");
			const at = body.at as EntryId;
			// Fork from the conversation that owns the entry, so the branch shows at its real place in the tree.
			const sourceId = await harness.commit(async (tx) => {
				let source = await tx.conversation(id);
				while (source?.parent && at <= source.parent.at) source = await tx.conversation(source.parent.conversationId);
				return source?.id ?? id;
			}, ctx);
			const source = (await harness.conversation(sourceId, ctx)) ?? conversation;
			const fork = await source.fork(at, { ownership: { kind: "ownerless" } }, ctx);
			return { id: fork.id };
		}
		case "abort":
			await conversation.abort(ctx);
			return {};
	}
	throw new HttpError(404, "Not found");
}

const server = createServer(async (req, res) => {
	res.setHeader("content-security-policy", "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'");
	res.setHeader("x-content-type-options", "nosniff");
	try {
		const result = await route(req, res);
		if (result !== undefined) res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
	} catch (error) {
		const status =
			error instanceof HttpError ? error.status : error instanceof ConversationBusy ? 409 : 500;
		if (status === 500) console.error(error);
		const message = error instanceof Error ? error.message : String(error);
		if (res.headersSent) res.end();
		else res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ error: message }));
	}
});
server.listen(Number(PORT), HOST, () => console.log(`poopi on http://${HOST}:${PORT}`));

// Exit code 0 (SIGTERM) asks `npm run serve` to start poopi again; Ctrl+C (130) and crashes end it.
const shutdown = (code: number) => async () => {
	server.close();
	await harness.close(ctx);
	process.exit(code);
};
process.once("SIGINT", shutdown(130));
process.once("SIGTERM", shutdown(0));
