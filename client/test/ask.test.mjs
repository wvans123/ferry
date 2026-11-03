import assert from "node:assert/strict";
import { test } from "node:test";
import { askOne } from "../lib/ask.mjs";

/** A terminal that answers with scripted picks: a function of (title, options) or a string to type. */
function fakeUi(script) {
	const seen = [];
	return {
		seen,
		select: async (title, options) => { seen.push(options); return script.shift()(options); },
		input: async () => script.shift(),
	};
}

const q = { question: "Which format?", options: [{ label: "Word" }, { label: "PPT", description: "10 slides" }, { label: "PDF" }], recommended: ["PPT"] };

test("single choice: the recommendation comes first and is marked; Other lets the user type", async () => {
	const ui = fakeUi([(o) => o[0]]);
	assert.equal(await askOne(ui, q), "PPT");
	assert.equal(ui.seen[0][0], "PPT (recommended) - 10 slides");
	assert.equal(ui.seen[0].at(-1), "Other (type your own)");
	assert.equal(await askOne(fakeUi([(o) => o.at(-1), "an Excel table"]), q), "an Excel table");
	assert.equal(await askOne(fakeUi([() => undefined]), q), undefined);
});

test("several choices: the recommendation starts ticked, Enter toggles, Done ends", async () => {
	const ui = fakeUi([(o) => o.find((x) => x.includes("Word")), (o) => o.at(-1), "Markdown", (o) => o[0]]);
	assert.equal(await askOne(ui, { ...q, multiSelect: true }), "Word; PPT; Markdown");
	assert.match(ui.seen[0][0], /^Done \(1 picked\)/);
	assert.ok(ui.seen[0].includes("[x] PPT (recommended) - 10 slides"));
});
