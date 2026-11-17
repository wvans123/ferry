import assert from "node:assert/strict";
import { test } from "node:test";
import { requireServerModels, restrictModelRuntime } from "../lib/server-models.mjs";

const response = (models) => ({ status: 200, body: { models } });
test("only explicitly configured server models are listed; a redundant auto alias is hidden", () => {
	assert.deepEqual(requireServerModels(response([{ id: "auto", routesTo: "owned" }, { id: "owned" }, { id: "second", ready: false }])), [{ id: "owned" }, { id: "second", ready: false }]);
});
test("empty, failed, malformed and duplicate catalogs fail closed", () => {
	for (const value of [response([]), response(null), response([{}]), response([{ id: "a" }, { id: "a" }]), { status: 503, body: { models: [{ id: "cached" }] } }]) {
		assert.throws(() => requireServerModels(value));
	}
});
function runtimeClass() {
	return class Runtime {
		constructor() {
			this.providers = new Map();
			this.models = { getProvider: (id) => this.providers.get(id), setProvider: (p) => this.providers.set(p.id, p), deleteProvider: (id) => this.providers.delete(id) };
		}
		static async create(options) { const value = new this(); value.options = options; return value; }
		recomposeProvider(id) {
			const items = [{ provider: id, id: "owned" }, { provider: id, id: "unapproved" }];
			const provider = { id, getModels: () => items, getAllModels: () => items };
			this.models.setProvider(provider); return provider;
		}
		stream(model) { return model; }
		getModel(provider, id) { return this.providers.get(provider)?.getModels().find((m) => m.id === id); }
		complete(model) { return model; }
	};
}
test("native providers and stale/custom local models cannot enter the runtime", async () => {
	const Runtime = runtimeClass(); restrictModelRuntime(Runtime, ["owned"]);
	const runtime = await Runtime.create({ modelsPath: "old-models.json", modelsStore: {}, allowModelNetwork: true });
	assert.equal(runtime.options.modelsPath, null); assert.equal(runtime.options.modelsStore, undefined);
	assert.equal(runtime.options.allowModelNetwork, false); assert.equal(runtime.modelNetworkEnabled, false);
	for (const id of ["anthropic", "openai", "local-custom"]) {
		runtime.recomposeProvider(id); assert.equal(runtime.models.getProvider(id), undefined);
		assert.throws(() => runtime.stream({ provider: id, id: "owned" }), /approved model list/);
	}
	runtime.recomposeProvider("ferry");
	assert.deepEqual(runtime.models.getProvider("ferry").getModels(), [{ provider: "ferry", id: "owned" }]);
	assert.deepEqual(runtime.models.getProvider("ferry").getAllModels(), [{ provider: "ferry", id: "owned" }]);
	assert.equal(runtime.stream({ provider: "ferry", id: "owned" }).id, "owned");
	assert.throws(() => runtime.complete({ provider: "ferry", id: "unapproved" }), /approved model list/);
});
test("reapplying policy replaces the allowlist without stacking patches", async () => {
	const Runtime = runtimeClass(); restrictModelRuntime(Runtime, ["owned"]); restrictModelRuntime(Runtime, ["unapproved"]);
	const runtime = await Runtime.create(); runtime.recomposeProvider("ferry");
	assert.deepEqual(runtime.models.getProvider("ferry").getModels().map((m) => m.id), ["unapproved"]);
	assert.throws(() => runtime.stream({ provider: "ferry", id: "owned" }));
});

test("old ferry model references restore the canonical server provider without adding aliases", async () => {
	const Runtime = runtimeClass();
	restrictModelRuntime(Runtime, [{ provider: "custom", id: "owned" }]);
	const runtime = await Runtime.create();
	runtime.recomposeProvider("custom");
	const restored = runtime.getModel("ferry", "owned");
	assert.deepEqual(restored, { provider: "custom", id: "owned" });
	assert.equal(runtime.stream(restored), restored);
	assert.equal(runtime.getModel("ferry", "removed"), undefined);
	assert.equal(runtime.getModel("unrelated", "owned"), undefined);
	assert.equal(runtime.models.getProvider("ferry"), undefined);
	restrictModelRuntime(Runtime, [{ provider: "next", id: "owned" }]);
	runtime.recomposeProvider("next");
	assert.equal(runtime.getModel("ferry", "owned").provider, "next");
});
test("unsupported engines do not silently disable isolation", () => {
	assert.throws(() => restrictModelRuntime(class {}, ["owned"]), /refusing to start/);
});

test("server default metadata and legacy auto routing preserve configured default order", () => {
    assert.deepEqual(requireServerModels({status: 200, body: {defaultModel: "b", models: [{id: "a"}, {id: "b"}]}}).map(m => m.id), ["b", "a"]);
    assert.deepEqual(requireServerModels(response([{id: "auto", routesTo: "b"}, {id: "a"}, {id: "b"}])).map(m => m.id), ["b", "a"]);
});
