// Runs pi extensions (pi.on, registerCommand, registerTool, appendEntry, ui.notify/setStatus) on Durable, with pi's own
// ExtensionRunner. Each conversation gets its own instances, as each pi session does, so state kept in an extension's
// closure stays in its conversation. Unsupported pi APIs throw a clear error that the extension's handler reports.
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import {
	DefaultResourceLoader,
	type Extension as PiExtension,
	ExtensionRunner,
	type ModelRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
	type ConversationId,
	defineEntry,
	defineExtension,
	defineTool,
	GenerationTask,
	type Harness,
	type JsonObject,
	hook,
	section,
	ToolTask,
} from "@earendil-works/pi-durable";

// pi.appendEntry() data; without `model` it stays out of the model's context, and render.ts does not show it.
const Custom = defineEntry<{ customType: string; data: JsonValue }>("pi.custom");

type Host = { runner: ExtensionRunner; status: Map<string, string>; notices: string[]; prompt: string; model?: unknown };

const unsupported = (target: object) =>
	new Proxy(target, {
		get: (t, key) =>
			(t as Record<PropertyKey, unknown>)[key] ??
			(() => {
				throw new Error(`${String(key)} is not supported in poopi`);
			}),
	});
const plain = new Proxy({}, { get: () => (...args: unknown[]) => args.at(-1) }); // theme.fg("accent", text) → text

export function piExtensions(options: {
	harness: () => Harness;
	models: ModelRuntime;
	agentDir: string;
	cwd: string;
	paths: string[];
	/** Loaded once at startup; their tools are installed for every conversation. */
	loaded: PiExtension[];
	expandSkill: (text: string) => Promise<string>;
}) {
	const { models, cwd } = options;
	// shortcut: hosts are never dropped, evict idle ones if many conversations make memory grow.
	const hosts = new Map<ConversationId, Promise<Host>>();
	const host = (id: ConversationId) => {
		let h = hosts.get(id);
		if (!h) {
			h = create(id);
			hosts.set(id, h);
			h.catch(() => hosts.delete(id));
		}
		return h;
	};

	async function create(id: ConversationId): Promise<Host> {
		const harness = options.harness();
		const conversation = await harness.conversation(id, ctx);
		if (!conversation) throw new Error(`No conversation ${id}`);
		// The whole history, fork ancestors included, so a fork restores what its parent had at the fork entry.
		const session = SessionManager.inMemory(cwd);
		let cursor;
		do {
			const page = await conversation.entries({ order: "ascending" }, 500, cursor, ctx);
			for (const e of page.items) if (Custom.is(e)) session.appendCustomEntry(e.data.customType, e.data.data);
			cursor = page.next;
		} while (cursor !== undefined);

		// Running pi's loader again runs every factory again: fresh extension instances for this conversation.
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir: options.agentDir,
			additionalExtensionPaths: options.paths,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await loader.reload();
		const { extensions, runtime } = loader.getExtensions();
		const runner = new ExtensionRunner(extensions, runtime, cwd, session, models as never);
		const h: Host = { runner, status: new Map(), notices: [], prompt: "" };
		const report = (error: unknown) => h.notices.push(error instanceof Error ? error.message : String(error));
		runner.onError((e) => report(`${e.extensionPath} ${e.event}: ${e.error}`));

		const submit = async (text: string, followUp: boolean) =>
			conversation.submit({ type: "input", content: text, whenBusy: followUp ? "followUp" : "steer" }, ctx);
		const noop = () => {};
		runner.bindCore(
			unsupported({
				sendUserMessage: (content: unknown, opts?: { deliverAs?: string; expandPromptTemplates?: boolean }) => {
					if (typeof content !== "string") throw new Error("sendUserMessage with images is not supported in poopi");
					const text = opts?.expandPromptTemplates ? options.expandSkill(content) : Promise.resolve(content);
					text.then((t) => submit(t, opts?.deliverAs === "followUp")).catch(report);
				},
				appendEntry: (customType: string, data?: unknown) => {
					session.appendCustomEntry(customType, data);
					const value = { customType, data: (data ?? null) as JsonValue };
					harness.commit((tx) => tx.appendEntry(Custom, id, { data: value }), ctx).catch(report);
				},
				getSessionName: () => undefined,
			}) as never,
			unsupported({
				getModel: () => h.model,
				getScopedModels: () => [],
				// shortcut: always idle, so extensions steer; Durable queues the input anyway. Track pi.live.run if one needs it.
				isIdle: () => true,
				isProjectTrusted: () => true,
				getSignal: () => undefined,
				hasPendingMessages: () => false,
				getContextUsage: () => undefined,
				abort: () => void conversation.abort(ctx).catch(report),
			}) as never,
			// Providers come from the startup load in server.ts.
			{ registerProvider: noop, registerNativeProvider: noop, unregisterProvider: noop, registerVirtualModel: noop, unregisterVirtualModel: noop },
		);
		runner.bindCommandContext(unsupported({}) as never);
		// Dialogs and TUI components answer undefined, which pi extensions read as "no UI" or "cancelled".
		const ui = {
			notify: (message: string) => void h.notices.push(message),
			setStatus: (key: string, text?: string) => void (text === undefined ? h.status.delete(key) : h.status.set(key, text)),
			theme: plain,
		};
		runner.setUIContext(new Proxy(ui, { get: (t, k) => (t as Record<PropertyKey, unknown>)[k] ?? noop }) as never, "rpc");
		await runner.emit({ type: "session_start", reason: "startup" });
		return h;
	}

	const tools = options.loaded.flatMap((e) => [...e.tools.values()]).map(({ definition }) =>
		defineTool({
			name: definition.name,
			description: definition.description,
			parameters: definition.parameters,
			execute: async (args, api, context) => {
				const { runner } = await host(api.conversationId);
				const tool = runner.getToolDefinition(definition.name);
				if (!tool) throw new Error(`${definition.name} is not registered in this conversation`);
				const signal = context.abortSignal;
				// shortcut: onUpdate (streamed partial results) is dropped; map it to api.output() if a tool needs it.
				const result = await tool.execute(api.callId, args, signal, undefined, runner.createToolContext(api.callId, signal));
				return { output: result.content, details: result.details as JsonValue };
			},
		}),
	);

	const extension = defineExtension({
		name: "pi-extensions",
		tools,
		sections: [
			// pi's before_agent_start, run before every request instead of once per prompt.
			section(
				"pi_extensions",
				async ({ conversationId, agent }) => {
					const h = await host(conversationId);
					h.model = agent.model && models.getModel(agent.model.provider, agent.model.modelId);
					// shortcut: a handler's `systemPrompt` replacement and injected `message` are ignored; only sections apply.
					const { systemPromptOptions } = await h.runner.emitBeforeAgentStart(
						{ messageType: "user", prompt: h.prompt },
						{ cwd, sections: {} },
					);
					const sections = Object.entries(systemPromptOptions.sections);
					return sections.map(([key, text]) => `<${key}>\n${text}\n</${key}>`).join("\n\n") || undefined;
				},
				{ tag: false },
			),
		],
		hooks: [
			hook(ToolTask, {
				beforeTool: async (call, api) => {
					const { runner } = await host(api.conversationId);
					const input = structuredClone(call.arguments) as JsonObject;
					const result = await runner.emitToolCall({ type: "tool_call", toolCallId: call.id, toolName: call.name, input });
					if (result?.block) return { block: result.reason ?? "Blocked by an extension" };
					return JSON.stringify(input) === JSON.stringify(call.arguments) ? undefined : { arguments: input };
				},
				afterTool: async (call, result, api) => {
					const { runner } = await host(api.conversationId);
					const changed = await runner.emitToolResult({
						type: "tool_result",
						toolCallId: call.id,
						toolName: call.name,
						input: call.arguments,
						content: [...(result.output ?? [])],
						details: result.details,
						isError: result.isError === true,
					});
					if (!changed) return undefined;
					const { content, details, isError } = changed;
					return { ...result, output: content ?? result.output, details: (details ?? result.details) as JsonValue, isError: isError ?? result.isError };
				},
			}),
			hook(GenerationTask, {
				// shortcut: agent_end carries no messages; fill them in if an extension reads them.
				onYield: async (_answer, api) => {
					await (await host(api.conversationId)).runner.emit({ type: "agent_end", messages: [] });
					return undefined;
				},
			}),
		],
	});

	return {
		extension,
		/** pi's input handling: an extension command or `handled` input returns undefined, otherwise the text to send. */
		async input(id: ConversationId, text: string, whenBusy: "steer" | "followUp") {
			const h = await host(id);
			const match = /^\/(\S+)\s*([\s\S]*)$/.exec(text);
			const command = match && h.runner.getCommand(match[1]);
			if (command) {
				await command.handler(match[2], h.runner.createCommandContext());
				return undefined;
			}
			const result = await h.runner.emitInput(text, undefined, "interactive", whenBusy);
			if (result.action === "handled") return undefined;
			h.prompt = result.action === "transform" ? result.text : text;
			return h.prompt;
		},
		/** Status texts and the notices since the last call, for the browser. */
		async ui(id: ConversationId) {
			const h = await hosts.get(id)?.catch(() => undefined);
			return { status: [...(h?.status.values() ?? [])].join(" "), notices: h?.notices.splice(0) ?? [] };
		},
	};
}
