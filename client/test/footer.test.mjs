import assert from "node:assert/strict";
import { test } from "node:test";
import { installFooter } from "../lib/footer.mjs";
import { DEFAULTS } from "../lib/config.mjs";

async function footer() {
	const index = import.meta.resolve("@earendil-works/pi-coding-agent");
	const { FooterComponent } = await import(new URL("./modes/interactive/components/footer.js", index).href);
	(await import(new URL("./modes/interactive/theme/theme.js", index).href)).initTheme("dark");
	const model = { id: "claude-opus-5.5", provider: "kiro", reasoning: true, contextWindow: 200000 };
	const session = {
		state: { model, thinkingLevel: "high" },
		model,
		routedModel: { model: { id: "claude-sonnet-9" }, thinkingLevel: "low" },
		modelRuntime: { isUsingSubscription: () => false },
		getContextUsage: () => ({ contextWindow: 200000, percent: 12.5, tokens: 25000 }),
		sessionManager: { getEntryCount: () => 0, getSessionId: () => "s", getLeafId: () => null, getEntries: () => [],
			getCwd: () => "/work/project", getSessionName: () => "" },
	};
	const data = { getGitBranch: () => null, getAvailableProviderCount: () => 3, getExtensionStatuses: () => new Map() };
	return new FooterComponent(session, data);
}

const text = (lines) => lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");

test("showModel is on by default", () => {
	assert.equal(DEFAULTS.showModel, true);
});

test("showModel = false: no model, provider or routed model name in the footer; the rest stays", async () => {
	let show = true;
	assert.equal(await installFooter(() => show), true);
	const f = await footer();
	const shown = text(f.render(100));
	assert.match(shown, /kiro/);
	assert.match(shown, /claude-opus-5\.5/);
	assert.match(shown, /claude-sonnet-9/);
	show = false;
	for (const width of [100, 60]) {
		const hidden = text(f.render(width));
		assert.doesNotMatch(hidden, /kiro|claude|opus|sonnet/i);
		assert.match(hidden, /12\.5%\/200k/); // the context figure is still there
		assert.match(hidden, /project/);
	}
	show = true;
	assert.match(text(f.render(100)), /claude-opus-5\.5/); // and it comes back
});
