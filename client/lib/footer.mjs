// showModel = false: the footer at the bottom right does not say which model answers (a screen others may see).
//
// pi's footer draws "(provider) model-id • thinking level → routed model" on its second line. Patching its render
// to run on a stand-in session (model id "ferry", no provider prefix, no routed model) keeps everything else it shows
// (folder, token counts, context %) and cannot show another model's or vendor's name. /model and /status are not
// touched: they show the real model when asked.
const COVER = "ferry";
const shims = new WeakMap(); // footer -> { session, data, shim } (kept while the footer's session stays the same)

const bound = (target, over) => new Proxy(target, {
	get(t, k) {
		if (k in over) return over[k](t);
		const v = Reflect.get(t, k, t);
		return typeof v === "function" ? v.bind(t) : v;
	},
});

/** The stand-in for one footer; kept, so pi's cached statistics keep working between frames. */
function standIn(footer) {
	const have = shims.get(footer);
	if (have && have.session === footer.session && have.data === footer.footerData) return have.shim;
	const session = bound(footer.session, {
		state: (t) => ({ ...t.state, model: t.state.model && { ...t.state.model, id: COVER } }),
		routedModel: () => undefined,
	});
	const data = bound(footer.footerData, { getAvailableProviderCount: () => () => 1 });
	const shim = Object.create(footer, { session: { value: session }, footerData: { value: data }, sessionStats: { value: undefined, writable: true } });
	shims.set(footer, { session: footer.session, data: footer.footerData, shim });
	return shim;
}

/** Patch pi's footer; `show()` says whether the model name is shown right now. Returns true when patched. */
export async function installFooter(show = () => true) {
	try {
		const index = import.meta.resolve("@earendil-works/pi-coding-agent");
		const { FooterComponent } = await import(new URL("./modes/interactive/components/footer.js", index).href);
		if (FooterComponent.prototype.__ferryModel) return true;
		const render = FooterComponent.prototype.render;
		FooterComponent.prototype.render = function renderFooter(width) {
			if (show()) return render.call(this, width);
			return render.call(standIn(this), width);
		};
		FooterComponent.prototype.__ferryModel = true;
		return true;
	} catch {
		return false;
	}
}
