// Pictures in the conversation (screenshots the agent read, images you attached), before they go to the server.
//
// A screenshot is easily 1–3 MB of base64: it fills an upload on its own (the 1 MB rule), makes every later request
// heavy, and costs as much as a long document. So before syncing:
// - every picture is made smaller once: at most 1568 pixels on its longer side (what Claude and GPT look at anyway)
//   and about 300 KB, as PNG or JPEG, whichever is smaller (cached, so the same picture always becomes the same bytes);
// - only the latest few pictures (keepImages, default 4) stay in the conversation; older ones are replaced by a short
//   note, and the agent reads the file again if it needs to look.
const NOTE = "[Ferry: an earlier picture was left out to keep the conversation small. Read the file again if you need to see it.]";
const MAX_SIDE = 1568;
const MAX_B64 = 300 * 1024;
const cache = new Map(); // original base64 (its first and last 64 chars + length) -> { data, mimeType }

let resizer;
async function loadResizer() {
	if (resizer !== undefined) return resizer;
	try {
		const index = import.meta.resolve("@earendil-works/pi-coding-agent");
		resizer = (await import(new URL("./utils/image-resize-core.js", index).href)).resizeImageInProcess;
	} catch {
		resizer = null; // a pi laid out differently: pictures go as they are
	}
	return resizer;
}

/** A smaller copy of a base64 picture (or the same one when it is small already). */
export async function smaller(b64, mimeType) {
	if (b64.length <= MAX_B64) return { data: b64, mimeType };
	const key = `${b64.length}:${b64.slice(0, 64)}:${b64.slice(-64)}`;
	if (cache.has(key)) return cache.get(key);
	const resize = await loadResizer();
	let out = { data: b64, mimeType };
	if (resize) {
		const r = await resize(Buffer.from(b64, "base64"), mimeType, { maxWidth: MAX_SIDE, maxHeight: MAX_SIDE, maxBytes: MAX_B64, jpegQuality: 80 }).catch(() => null);
		if (r?.data) out = { data: r.data, mimeType: r.mimeType };
	}
	cache.set(key, out);
	return out;
}

/** Every picture in a request, in order: { get(): {data, mimeType}, set(data, mimeType), drop() }. */
function findPictures(messages) {
	const found = [];
	const visit = (arr) => {
		if (!Array.isArray(arr)) return;
		for (let i = 0; i < arr.length; i++) {
			const p = arr[i];
			if (!p || typeof p !== "object") continue;
			if (p.type === "image_url") { // OpenAI style: a data: URL
				const url = typeof p.image_url === "string" ? p.image_url : p.image_url?.url;
				const m = /^data:([\w/.+-]+);base64,(.*)$/s.exec(url ?? "");
				if (!m) continue;
				found.push({
					get: () => ({ mimeType: m[1], data: m[2] }),
					set: (data, mime) => { arr[i] = { ...p, image_url: { ...(typeof p.image_url === "object" ? p.image_url : {}), url: `data:${mime};base64,${data}` } }; },
					drop: () => { arr[i] = { type: "text", text: NOTE }; },
				});
			} else if (p.type === "image" && p.source?.type === "base64") { // Claude style
				found.push({
					get: () => ({ mimeType: p.source.media_type, data: p.source.data }),
					set: (data, mime) => { arr[i] = { ...p, source: { ...p.source, media_type: mime, data } }; },
					drop: () => { arr[i] = { type: "text", text: NOTE }; },
				});
			} else if (p.type === "tool_result" && Array.isArray(p.content)) {
				visit(p.content);
			}
		}
	};
	for (const m of messages) visit(m?.content);
	return found;
}

/** Make the pictures in these messages smaller and keep only the latest `keep` (changes the messages in place). */
export async function fitPictures(messages, keep = 4) {
	const pics = findPictures(messages);
	const cut = Math.max(0, pics.length - Math.max(0, keep));
	for (let i = 0; i < pics.length; i++) {
		if (i < cut) {
			pics[i].drop();
			continue;
		}
		const { data, mimeType } = pics[i].get();
		const s = await smaller(data, mimeType);
		if (s.data !== data) pics[i].set(s.data, s.mimeType);
	}
	return pics.length;
}
