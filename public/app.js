const $ = (id) => document.getElementById(id);
const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

let models = []; // [{ provider, id, name, levels }]
let agent; // { provider, modelId, thinkingLevel } of the open conversation, or for the next new one
let conversations = []; // [{ id, parent?, title? }]
let current; // open conversation ID; undefined for a new session
let events;

async function api(path, body) {
	const init = body && { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
	const response = await fetch(path, init);
	const data = await response.json();
	if (!response.ok) throw new Error(data.error);
	return data;
}

// Shows a failed action under the transcript instead of losing it in the console.
const guard = (action) => async (...args) => {
	$("error").textContent = "";
	try {
		await action(...args);
	} catch (error) {
		$("error").textContent = error.message;
	}
};

// Keeps the transcript scrolled to the bottom while new content arrives, unless the user scrolled up.
function stick(change) {
	const scroll = $("scroll");
	const atBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 40;
	change();
	if (atBottom) scroll.scrollTop = scroll.scrollHeight;
}

function fill(select, values, value, label = (v) => v) {
	// A stored value that is no longer offered stays visible rather than showing another one as selected.
	const all = value === undefined || values.includes(value) ? values : [value, ...values];
	select.replaceChildren(...all.map((v) => new Option(label(v), v, false, v === value)));
}

const modelOf = (a) => models.find((m) => m.provider === a.provider && m.id === a.modelId);

// The supported level nearest to the wanted one.
function clamp(levels, level) {
	const distance = (l) => Math.abs(LEVELS.indexOf(l) - LEVELS.indexOf(level));
	return levels.reduce((best, l) => (distance(l) < distance(best) ? l : best), levels[0]);
}

function showAgent() {
	fill($("provider"), [...new Set(models.map((m) => m.provider))], agent.provider);
	const offered = models.filter((m) => m.provider === agent.provider);
	fill($("model"), offered.map((m) => m.id), agent.modelId, (id) => offered.find((m) => m.id === id)?.name ?? id);
	fill($("effort"), modelOf(agent)?.levels ?? [], agent.thinkingLevel);
}

const pick = guard(async (change) => {
	const next = { ...agent, ...change };
	if (change.provider) next.modelId = models.find((m) => m.provider === change.provider).id;
	next.thinkingLevel = clamp(modelOf(next).levels, next.thinkingLevel);
	agent = next;
	showAgent();
	if (current !== undefined) await api(`/api/c/${current}/agent`, agent);
});
$("provider").onchange = (e) => pick({ provider: e.target.value });
$("model").onchange = (e) => pick({ modelId: e.target.value });
$("effort").onchange = (e) => pick({ thinkingLevel: e.target.value });

const element = (tag, ...children) => {
	const node = document.createElement(tag);
	node.append(...children);
	return node;
};

function link(conversation) {
	const a = element("a", conversation.title ?? `(empty #${conversation.id})`);
	a.href = `#${conversation.id}`;
	a.title = a.textContent;
	if (conversation.id === current) a.setAttribute("aria-current", "page");
	return a;
}

function showSidebars() {
	const roots = conversations.filter((c) => c.parent === undefined).reverse();
	$("session-list").replaceChildren(...roots.map((c) => element("li", link(c))));
	const byId = new Map(conversations.map((c) => [c.id, c]));
	let root = byId.get(current);
	while (root?.parent !== undefined) root = byId.get(root.parent);
	const branch = (c) => {
		const children = conversations.filter((child) => child.parent === c.id);
		return element("li", link(c), ...(children.length ? [element("ul", ...children.map(branch))] : []));
	};
	$("tree").replaceChildren(...(root ? [element("ul", branch(root))] : []));
}

async function refresh() {
	conversations = await api("/api/conversations");
	showSidebars();
}

function open() {
	events?.close();
	current = location.hash.length > 1 ? Number(location.hash.slice(1)) : undefined;
	$("transcript").replaceChildren();
	$("live").replaceChildren();
	$("stats").textContent = "";
	$("stop").hidden = true;
	$("error").textContent = "";
	showSidebars();
	showAgent();
	$("input").focus();
	if (current === undefined) return;
	events = new EventSource(`/api/c/${current}/events`);
	events.addEventListener("entries", (e) => {
		const { reset, html } = JSON.parse(e.data);
		stick(() => {
			if (reset) $("transcript").replaceChildren();
			$("transcript").insertAdjacentHTML("beforeend", html);
		});
	});
	events.addEventListener("state", (e) => {
		const state = JSON.parse(e.data);
		stick(() => ($("live").innerHTML = state.live));
		$("stats").textContent = state.stats;
		$("stop").hidden = !state.busy;
		// Only on change: rebuilding the dropdowns closes one the user has open.
		if (state.agent.provider && JSON.stringify(state.agent) !== JSON.stringify(agent)) {
			agent = state.agent;
			showAgent();
		}
	});
	// EventSource reconnects by itself; CLOSED means it gave up (for example a 404).
	events.onerror = () => {
		if (events.readyState === EventSource.CLOSED) $("error").textContent = "Lost the connection to the server";
	};
}

const send = guard(async (mode) => {
	const text = $("input").value;
	if (text.trim() === "") return;
	if (current === undefined) {
		const { id } = await api("/api/conversations", { ...agent, text });
		location.hash = `#${id}`;
	} else {
		await api(`/api/c/${current}/submit`, { text, mode });
	}
	$("input").value = "";
	await refresh();
});
$("input").addEventListener("keydown", (e) => {
	if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
	e.preventDefault();
	send(e.altKey ? "followUp" : "steer");
});
$("composer").onsubmit = (e) => {
	e.preventDefault();
	send("steer");
};
$("stop").onclick = guard(() => api(`/api/c/${current}/abort`, {}));

$("transcript").addEventListener(
	"click",
	guard(async (e) => {
		if (!e.target.matches(".fork")) return;
		const entry = e.target.closest("article");
		let at = entry.dataset.id;
		if (entry.classList.contains("user")) {
			// Like pi's /tree on a user message: branch from just before it, with its text in the editor.
			$("input").value = entry.querySelector(".text").textContent;
			at = entry.previousElementSibling?.dataset.id;
		}
		// Before the first message there is nothing to branch from: start a new session with the same model.
		if (at === undefined) location.hash = "";
		else location.hash = `#${(await api(`/api/c/${current}/fork`, { at: Number(at) })).id}`;
		await refresh();
	}),
);

window.addEventListener("hashchange", open);
if (matchMedia("(max-width: 900px)").matches) for (const side of document.querySelectorAll(".side")) side.open = false;
await guard(async () => {
	const available = await api("/api/models");
	models = available.models;
	if (models.length === 0) throw new Error("No models with credentials; log in with pi or set an API key");
	agent = available.default;
	const model = modelOf(agent) ?? models[0];
	agent = { provider: model.provider, modelId: model.id, thinkingLevel: clamp(model.levels, agent.thinkingLevel ?? "off") };
	await refresh();
	open();
})();
