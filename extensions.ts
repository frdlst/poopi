// Durable extensions in one directory: each top-level .ts/.js file default-exports one extension. A changed, added or
// removed file is reloaded within a second, without a restart.
import { mkdir, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Extension, Registry } from "@earendil-works/pi-durable";

export type ExtensionStatus = { file: string; name?: string; error?: string };

export async function watchExtensions(registry: Registry, dir: string, reserved: readonly string[]) {
	await mkdir(dir, { recursive: true });
	const files = new Map<string, { mtime: number } & ExtensionStatus>();

	async function load(file: string, mtime: number) {
		const old = files.get(file);
		const status: { mtime: number } & ExtensionStatus = { file, mtime, name: old?.name };
		files.set(file, status);
		try {
			// shortcut: each reload leaves the old module in memory, and modules it imports are not reloaded.
			const extension = (await import(`${pathToFileURL(join(dir, file)).href}?v=${mtime}`)).default as Extension;
			if (typeof extension?.name !== "string") throw new Error("default export is not an extension");
			const taken = [...files.values()].some((other) => other.file !== file && other.name === extension.name);
			if (reserved.includes(extension.name) || taken) throw new Error(`extension name ${extension.name} is taken`);
			if (old?.name && old.name !== extension.name) registry.uninstall({ name: old.name });
			registry.install(extension); // replaces the old version in place; running tool calls finish on it
			status.name = extension.name;
		} catch (error) {
			// The old version stays installed until a version that loads replaces it.
			status.error = error instanceof Error ? error.message : String(error);
			console.error(`extension ${file}: ${status.error}`);
		}
	}

	// Polling rather than fs.watch, which on FreeBSD does not report writes to files in a watched directory.
	async function scan() {
		const present = new Set<string>();
		for (const file of await readdir(dir)) {
			if (!/\.[cm]?[jt]s$/.test(file) || file.endsWith(".test.ts")) continue;
			const info = await stat(join(dir, file)).catch(() => undefined);
			if (!info?.isFile()) continue;
			present.add(file);
			if (files.get(file)?.mtime !== info.mtimeMs) await load(file, info.mtimeMs);
		}
		for (const [file, status] of files) {
			if (present.has(file)) continue;
			if (status.name) registry.uninstall({ name: status.name });
			files.delete(file);
		}
	}

	await scan();
	let scanning = false;
	setInterval(() => {
		if (scanning) return;
		scanning = true;
		scan()
			.catch((error) => console.error("extensions scan", error))
			.finally(() => (scanning = false));
	}, 1000).unref();
	return (): ExtensionStatus[] => [...files.values()].map(({ file, name, error }) => ({ file, name, error }));
}
