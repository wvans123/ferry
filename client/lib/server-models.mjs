// Ferry's server is the only source of model availability. Never fall back to Pi catalogs.
const ISOLATION = Symbol.for("ferry.server-models-only");

export function requireServerModels(response) {
	if (response.status !== 200) throw new Error(`HTTP ${response.status}: cannot load the Ferry server model list`);
	if (!Array.isArray(response.body?.models)) throw new Error("The Ferry server returned an invalid model list");
	const listed = response.body.models;
	const models = listed.filter((m) => !(m?.id === "auto" && m.routesTo && listed.some((other) => other?.id === m.routesTo)));
	if (!models.length) throw new Error("No models configured on the Ferry server. Add providers and models in its admin page.");
	if (models.some((m) => !m || typeof m.id !== "string" || !m.id.trim()) || new Set(models.map((m) => m.id)).size !== models.length) {
		throw new Error("The Ferry server returned invalid or duplicate model IDs");
	}
	const defaultId = response.body.defaultModel ?? listed.find((m) => m?.id === "auto")?.routesTo;
	const preferred = models.find((m) => m.id === defaultId);
	return preferred ? [preferred, ...models.filter((m) => m !== preferred)] : models;
}

// Pi's CLI does not accept a modelRuntime injection. Restrict the shared runtime class in this
// Ferry process, before main() constructs it. This also covers SDK-created subagent runtimes.
// Nothing is written to Pi's installation, auth.json, models.json or catalog cache.
export function restrictModelRuntime(ModelRuntime, models) {
	const rows = models.map((m) => typeof m === "string" ? { provider: "ferry", id: m } : { provider: m.provider || "ferry", id: m.id });
	const ids = new Set(rows.map((m) => `${m.provider}/${m.id}`));
	const providers = new Set(rows.map((m) => m.provider));
	if (typeof ModelRuntime?.create !== "function" || typeof ModelRuntime.prototype?.recomposeProvider !== "function") {
		throw new Error("Cannot enforce Ferry-only models with this Pi runtime; refusing to start");
	}
	if (ModelRuntime[ISOLATION]) {
		ModelRuntime[ISOLATION].ids = ids;
		ModelRuntime[ISOLATION].providers = providers;
		return;
	}
	const state = { ids, providers };
	const create = ModelRuntime.create;
	const recompose = ModelRuntime.prototype.recomposeProvider;
	ModelRuntime.create = async function (options = {}) {
		const runtime = await create.call(this, { ...options, modelsPath: null, modelsStore: undefined,
			modelsStorePath: undefined, allowModelNetwork: false });
		runtime.modelNetworkEnabled = false;
		return runtime;
	};
	ModelRuntime.prototype.recomposeProvider = function (providerId) {
		if (!this.models?.deleteProvider || !this.models?.getProvider || !this.models?.setProvider) {
			throw new Error("Cannot enforce Ferry-only models with this Pi runtime; refusing to start");
		}
		if (!state.providers.has(providerId)) {
			this.models.deleteProvider(providerId);
			return undefined;
		}
		const result = recompose.call(this, providerId);
		const provider = this.models.getProvider(providerId);
		if (!provider) return result;
		const approved = (models) => models.filter((m) => state.ids.has(`${m.provider}/${m.id}`));
		const restricted = { ...provider,
			getModels: (...args) => approved(provider.getModels(...args)),
			getAllModels: (...args) => approved((provider.getAllModels ?? provider.getModels).apply(provider, args)),
		};
		this.models.setProvider(restricted);
		return restricted;
	};
	for (const method of ["stream", "streamSimple", "complete", "completeSimple", "classify", "generateImages"]) {
		const original = ModelRuntime.prototype[method];
		if (typeof original !== "function") continue;
		ModelRuntime.prototype[method] = function (model, ...args) {
			if (!state.ids.has(`${model?.provider}/${model?.id}`)) {
				throw new Error("This model is not in the Ferry server's approved model list");
			}
			return original.call(this, model, ...args);
		};
	}
	Object.defineProperty(ModelRuntime, ISOLATION, { value: state });
}
