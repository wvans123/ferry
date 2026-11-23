import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_B64, fitPictures, smaller } from "../lib/pictures.mjs";

async function bigPng(w = 2400, h = 1600) {
	const index = import.meta.resolve("@earendil-works/pi-coding-agent");
	const { loadPhoton } = await import(new URL("./utils/photon.js", index).href);
	const photon = await loadPhoton();
	const px = new Uint8Array(w * h * 4);
	for (let i = 0; i < px.length; i++) px[i] = (i * 2654435761) >>> 24; // noise: does not compress
	const img = new photon.PhotonImage(px, w, h);
	const b64 = Buffer.from(img.get_bytes()).toString("base64");
	img.free();
	return b64;
}

test("a big screenshot is made smaller before it is sent, the same way every time", async () => {
	const b64 = await bigPng();
	assert.ok(b64.length > 1_000_000);
	const a = await smaller(b64, "image/png");
	const b = await smaller(b64, "image/png");
	assert.ok(a.data.length <= MAX_B64, `still ${a.data.length}`);
	assert.equal(a.data, b.data);
});

test("only the latest pictures stay; older ones become a note", async () => {
	const pic = (n) => ({ type: "image", source: { type: "base64", media_type: "image/png", data: `AAAA${n}` } });
	const msgs = [
		{ role: "user", content: [{ type: "text", text: "look" }, pic(1)] },
		{ role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: [pic(2)] }] },
		{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,BBBB3" } }] },
	];
	assert.equal(await fitPictures(msgs, 2), 3);
	assert.match(msgs[0].content[1].text, /picture was left out/);
	assert.equal(msgs[1].content[0].content[0].source.data, "AAAA2");
	assert.match(msgs[2].content[0].image_url.url, /BBBB3$/);
});

test("a picture becomes a placeholder note once maxSteps assistant replies have passed", async () => {
	const pic = (n) => ({ type: "image", source: { type: "base64", media_type: "image/png", data: `AAAA${n}` } });
	const make = (repliesAfter) => [
		{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [pic(1)] }] },
		...Array.from({ length: repliesAfter }, (_, i) => ({ role: "assistant", content: `step ${i + 1}` })),
	];
	// 3 assistant replies after the image: still kept when maxSteps = 4
	const fresh = make(3);
	await fitPictures(fresh, 4, 4);
	assert.equal(fresh[0].content[0].content[0].source.data, "AAAA1");
	// 4 assistant replies after the image: degraded to placeholder note
	const aged = make(4);
	await fitPictures(aged, 4, 4);
	assert.match(aged[0].content[0].content[0].text, /picture was left out/);
});
