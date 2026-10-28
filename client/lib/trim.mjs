// Fewer slash commands: hide pi's built-in commands that Ferry users do not need, and pi's llama.cpp extension.
//
// pi keeps its built-in command list in dist/core/slash-commands.js and its built-in extensions in
// dist/extensions/index.js; neither is exported from the package, so they are imported by file (the same module
// instances pi's interactive mode and main() use) and edited in place before main() runs.
// A hidden command still works when typed in full; it is only left out of the "/" list.

// Kept: model, name, session, new, compact, resume, quit (and /mcp, /skill:..., Ferry's own commands)
export const HIDDEN_BUILTINS = ["settings", "tree", "thinking", "scoped-models", "export", "import", "share", "bug", "copy",
	"changelog", "hotkeys", "fork", "clone", "trust", "login", "logout", "reload"];
const DROPPED_EXTENSIONS = ["llama.cpp"];

export async function trimPi() {
	const index = import.meta.resolve("@earendil-works/pi-coding-agent"); // .../dist/index.js
	const result = { hidden: [], dropped: [] };
	try {
		const { BUILTIN_SLASH_COMMANDS: list } = await import(new URL("./core/slash-commands.js", index).href);
		for (let i = list.length - 1; i >= 0; i--) {
			if (HIDDEN_BUILTINS.includes(list[i].name)) result.hidden.push(...list.splice(i, 1).map((c) => c.name));
		}
	} catch {
		// a pi version laid out differently: every command stays listed
	}
	try {
		const { builtInExtensions: exts } = await import(new URL("./extensions/index.js", index).href);
		for (let i = exts.length - 1; i >= 0; i--) {
			if (DROPPED_EXTENSIONS.includes(exts[i].name)) result.dropped.push(...exts.splice(i, 1).map((e) => e.name));
		}
	} catch {
		// as above
	}
	return result;
}
