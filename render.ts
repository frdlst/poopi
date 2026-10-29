// Server-side HTML for transcript entries and live state. Everything model-generated passes through `md()` or `esc()`.
import type { AssistantMessage, Message, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type { EntryRecord, InboxState, LiveState } from "@earendil-works/pi-durable";
import hljs from "highlight.js/lib/common";
import { Marked } from "marked";

export const esc = (s: string): string =>
	s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const marked = new Marked({
	renderer: {
		// Raw HTML from the model is shown as text, never parsed.
		html: ({ text }) => esc(text),
		code: ({ text, lang }) => {
			const language = lang?.split(/\s/)[0];
			const body = language && hljs.getLanguage(language) ? hljs.highlight(text, { language }).value : esc(text);
			return `<pre><code class="hljs">${body}</code></pre>\n`;
		},
		// Only plain web links; `false` falls back to marked's own (escaping) renderer.
		link({ href, tokens }) {
			return /^(https?:|mailto:)/i.test(href) ? false : this.parser.parseInline(tokens);
		},
		// Images become links, so the model cannot make the browser fetch URLs on its own.
		image: ({ href, text }) =>
			/^https?:/i.test(href) ? `<a href="${esc(href)}">${esc(text || href)}</a>` : esc(text),
	},
});

export const md = (text: string): string => marked.parse(text, { async: false });

const userText = (message: Message | undefined): string => {
	const content = message?.content ?? "";
	if (typeof content === "string") return content;
	return content.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
};

// One line naming the call, like the TUI: `bash ls -la`, `edit server.ts`.
const callSummary = ({ name, arguments: args }: ToolCall): string =>
	`${name} ${args.command ?? args.path ?? ""}`.split("\n")[0].slice(0, 120);

export function renderAssistant(message: AssistantMessage): string {
	let html = "";
	for (const block of message.content) {
		if (block.type === "text") html += md(block.text);
		else if (block.type === "thinking" && block.thinking.trim() !== "")
			html += `<details class="thinking"><summary>Thinking</summary>${md(block.thinking)}</details>`;
		else if (block.type === "toolCall")
			html += `<details class="tool"><summary>${esc(callSummary(block))}</summary><pre>${esc(JSON.stringify(block.arguments, null, 2))}</pre></details>`;
	}
	if (message.stopReason === "error") html += `<p class="error">${esc(message.errorMessage ?? "Error")}</p>`;
	if (message.stopReason === "aborted") html += `<p class="note">Aborted</p>`;
	return html;
}

/** One transcript entry as an `<article>`, or "" for kinds that are not shown (system prompt changes). */
export function renderEntry(entry: EntryRecord): string {
	const message = entry.model?.[0];
	const open = (kind: string) => `<article class="${kind}" data-id="${entry.id}">`;
	const fork = `<button class="fork" title="Branch from here">branch</button>`;
	switch (entry.kind) {
		case "pi.user":
			return `${open("user")}${fork}<div class="text">${esc(userText(message))}</div></article>`;
		case "pi.assistant":
			return `${open("assistant")}${fork}${renderAssistant(message as AssistantMessage)}</article>`;
		case "pi.tool": {
			const result = message as ToolResultMessage;
			const output = userText(result as unknown as Message);
			const label = `${result.toolName} ${result.isError ? "failed" : "output"}, ${output.split("\n").length} lines`;
			return `${open(result.isError ? "tool error" : "tool")}<details><summary>${esc(label)}</summary><pre>${esc(output)}</pre></details></article>`;
		}
		case "pi.compaction":
			return `${open("compaction")}<details><summary>Context compacted</summary>${md(userText(message))}</details></article>`;
		case "pi.reset":
			return `${open("reset")}<p class="note">Context reset</p>${message ? md(userText(message)) : ""}</article>`;
		default:
			return "";
	}
}

/** The in-flight answer, retries, failures and queued inputs, below the transcript. */
export function renderLive(live: LiveState, inbox: InboxState | undefined): string {
	let html = "";
	const generation = live.generation;
	if (generation?.message) html += `<article class="assistant">${renderAssistant(generation.message as AssistantMessage)}</article>`;
	else if (live.run) html += `<p class="note">Working…</p>`;
	if (generation?.retry)
		html += `<p class="error">Retrying at ${new Date(generation.retry.at).toLocaleTimeString()}: ${esc(generation.retry.error)}</p>`;
	if (live.compactions?.length) html += `<p class="note">Compacting context…</p>`;
	if (live.compactionFailure) html += `<p class="error">Compaction failed: ${esc(live.compactionFailure.error)}</p>`;
	for (const item of inbox?.items ?? [])
		if (item.mode !== "write") html += `<p class="queued">${item.mode === "steer" ? "Steer" : "Follow-up"}: ${esc(userText({ role: "user", content: item.content } as Message))}</p>`;
	return html;
}

/** Title of a conversation: its first own user message. */
export const titleOf = (entries: readonly EntryRecord[]): string | undefined => {
	const first = entries.find((e) => e.kind === "pi.user");
	return first && userText(first.model?.[0]).slice(0, 80);
};
