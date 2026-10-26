// Browser control through Microsoft's Playwright MCP server (shipped with Ferry), using a browser that is already
// installed on this computer: Edge on Windows, Chrome elsewhere. Nothing is downloaded.
// The browser uses this computer's own network, like when you browse yourself (company proxy and gateway included).
// Every browser action passes the same permission check as commands; read-only ones (page snapshot, screenshot)
// go ahead, others ask unless allowed (answer "always allow" once to stop the questions for mcp__browser__*).
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export function browserCommand(cfg) {
	let cli;
	try {
		cli = join(dirname(createRequire(import.meta.url).resolve("@playwright/mcp/package.json")), "cli.js");
	} catch {
		return null;
	}
	if (!existsSync(cli)) return null;
	const args = [cli];
	if (cfg.browserPath) args.push("--executable-path", cfg.browserPath);
	else args.push("--browser", process.platform === "win32" ? "msedge" : "chrome");
	if (cfg.browserHeadless) args.push("--headless");
	if (Array.isArray(cfg.browserArgs)) args.push(...cfg.browserArgs); // any other Playwright MCP option
	return { command: process.execPath, args };
}

export function createBrowser(cfg) {
	return (pi) => {
		if (!cfg.browser) return;
		const cmd = browserCommand(cfg);
		if (!cmd) return;
		pi.registerMcpServer("browser", {
			...cmd,
			exposure: "direct",
			// runs arbitrary code on this computer, or rarely useful: keep them away from the model
			toolExposure: { browser_run_code_unsafe: "hidden", browser_drop: "hidden", browser_emulate_media: "hidden",
				browser_resize: "hidden" },
			timeout: 120,
			description: "Control a web browser on the user's computer: open pages, click, type, read what is on the page. " +
				"It uses the computer's own network. Start with browser_navigate, then browser_snapshot to see the page.",
		});
	};
}
