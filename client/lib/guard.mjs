// Local safety rules, enforced on the client machine (the server cannot override them):
// blocked paths are never read, changed or used in commands; selected tools need a yes before they run.
const PATH_TOOLS = new Set(["read", "write", "edit", "grep", "find", "ls"]);
const SHELL_TOOLS = new Set(["bash", "powershell"]);

export function createGuard(cfg) {
	const blocked = cfg.blockedPaths.map((p) => p.toLowerCase());
	const approve = new Set(cfg.approve);
	const autoApprove = process.env.FERRY_AUTO_APPROVE === "1";

	return (pi) => {
		pi.on("tool_call", async (event, ctx) => {
			const input = event.input ?? {};
			const target = PATH_TOOLS.has(event.toolName) ? input.path
				: SHELL_TOOLS.has(event.toolName) ? input.command : undefined;
			const low = typeof target === "string" ? target.toLowerCase() : "";
			const hit = low && blocked.find((p) => low.includes(p));
			if (hit) {
				if (ctx.hasUI) ctx.ui.notify(`Ferry blocked ${event.toolName} on a protected path (${hit})`, "warning");
				// The reason goes to the model, so it does not repeat the protected name
				return { block: true, reason: "Access to this path is not allowed by local policy" };
			}
			if (approve.has(event.toolName) && !autoApprove) {
				if (!ctx.hasUI) return { block: true, reason: "No terminal available to approve this action" };
				const detail = input.command ?? input.path ?? JSON.stringify(input).slice(0, 300);
				const choice = await ctx.ui.select(`Allow ${event.toolName}?\n\n  ${detail}`, ["Allow", "Deny"]);
				if (choice !== "Allow") return { block: true, reason: "Rejected by user" };
			}
			return undefined;
		});
	};
}
