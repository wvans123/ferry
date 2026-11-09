import assert from "node:assert/strict";
import { test } from "node:test";
import { tarCommand } from "../lib/toolbins.mjs";

test("tar on Windows is the one in System32, never a bare tar that Git's GNU tar can shadow", () => {
	const win = tarCommand(true, { SystemRoot: "D:\\Win" });
	assert.match(win, /^D:\\Win[\\/]System32[\\/]tar\.exe$/);
	assert.match(tarCommand(true, {}), /^C:\\Windows[\\/]System32[\\/]tar\.exe$/);
	assert.equal(tarCommand(false), "tar");
});
