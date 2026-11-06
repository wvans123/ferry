import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "ferry-only-settings-"));
process.env.FERRY_HOME = home;
const { ensureAgentDir, AGENT_DIR } = await import("../lib/config.mjs");
test("server allowlist replaces old local providers, defaults and enabled-model overlays", () => {
    try {
        mkdirSync(AGENT_DIR, { recursive: true });
        const file = join(AGENT_DIR, "settings.json");
        writeFileSync(file, JSON.stringify({ defaultProvider: "anthropic", defaultModel: "official",
            enabledModels: ["anthropic/*", "openai/*"], customPreference: "keep" }));
        ensureAgentDir("owned", ["owned", "second"]);
        let settings = JSON.parse(readFileSync(file));
        assert.equal(settings.defaultProvider, "ferry");
        assert.equal(settings.defaultModel, "owned");
        assert.deepEqual(settings.enabledModels, ["ferry/owned", "ferry/second"]);
        assert.equal(settings.customPreference, "keep");
        ensureAgentDir("second", ["second"]);
        settings = JSON.parse(readFileSync(file));
        assert.equal(settings.defaultModel, "second");
        assert.deepEqual(settings.enabledModels, ["ferry/second"]);
    } finally { rmSync(home, { recursive: true, force: true }); }
});

test("startup refuses a dead server instead of using a stale cached catalog", () => {
    const temp = mkdtempSync(join(tmpdir(), "ferry-stale-models-"));
    try {
        writeFileSync(join(temp, "models-cache.json"), JSON.stringify([{ id: "stale" }]));
        writeFileSync(join(temp, "config.json"), JSON.stringify({ updateCheck: false }));
        const result = spawnSync(process.execPath, ["client/bin/ferry.mjs", "--mode", "json", "-p", "no request"], {
            cwd: new URL("../../", import.meta.url), encoding: "utf8", timeout: 20000,
            env: { ...process.env, FERRY_HOME: temp, FERRY_SERVER: "http://127.0.0.1:1", FERRY_TOKEN: "dummy-test-token" }
        });
        assert.equal(result.error, undefined);
        assert.notEqual(result.status, 0);
        assert.match(result.stdout + result.stderr, /server|fetch|model/i);
        assert.doesNotMatch(result.stdout, /"type":"message_start"/);
    } finally { rmSync(temp, { recursive: true, force: true }); }
});


test("server provider groups replace stale enabled models and keep a valid saved selection", () => {
    // ensureAgentDir uses the module's home, which the preceding test cleaned up.
    try {
        mkdirSync(AGENT_DIR, { recursive: true });
        const file = join(AGENT_DIR, "settings.json");
        writeFileSync(file, JSON.stringify({ defaultProvider: "ferry", defaultModel: "second", enabledModels: ["openai/*"] }));
        ensureAgentDir("owned", [{ id: "owned", provider: "kiro" }, { id: "second", provider: "relay" }]);
        const settings = JSON.parse(readFileSync(file));
        assert.equal(settings.defaultProvider, "relay");
        assert.equal(settings.defaultModel, "second");
        assert.deepEqual(settings.enabledModels, ["kiro/owned", "relay/second"]);
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});
