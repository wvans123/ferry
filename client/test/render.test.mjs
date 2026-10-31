import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.FERRY_HOME = mkdtempSync(join(tmpdir(), "ferry-render-"));
const { blockedSite, findElectron } = await import("../lib/render.mjs");

test("blocked sites cover their subdomains, not look-alikes", () => {
	const list = ["corp-mail.com", "*.drive.example", "https://chat.example.org/login"];
	assert.equal(blockedSite("https://corp-mail.com/inbox", list), "corp-mail.com");
	assert.equal(blockedSite("https://webmail.corp-mail.com", list), "corp-mail.com");
	assert.equal(blockedSite("files.drive.example", list), "drive.example");
	assert.equal(blockedSite("http://chat.example.org:8080/x", list), "chat.example.org");
	assert.equal(blockedSite("https://notcorp-mail.com", list), "");
	assert.equal(blockedSite("https://example.org", list), "");
	assert.equal(blockedSite("https://anything", []), "");
});

test("Electron is found from the setting, the environment, or FERRY_HOME/electron", () => {
	const fake = join(process.env.FERRY_HOME, "my-electron.exe");
	writeFileSync(fake, "");
	assert.equal(findElectron({ electronPath: fake, _skipGlobal: true }, {}), fake);
	assert.equal(findElectron({ _skipGlobal: true }, { FERRY_ELECTRON: fake }), fake);
	assert.equal(findElectron({ electronPath: join(process.env.FERRY_HOME, "missing"), _skipGlobal: true }, {}), "");
	const exe = process.platform === "win32" ? "electron.exe" : process.platform === "darwin" ? "Electron.app/Contents/MacOS/Electron" : "electron";
	const home = join(process.env.FERRY_HOME, "electron", "node_modules", "electron", "dist", exe);
	mkdirSync(join(home, ".."), { recursive: true });
	writeFileSync(home, "");
	assert.equal(findElectron({ _skipGlobal: true }, {}), home);
});
