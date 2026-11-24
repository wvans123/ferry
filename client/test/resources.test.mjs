import assert from "node:assert/strict";
import { test, after } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const temp = mkdtempSync(join(tmpdir(), "ferry-resources-"));
process.env.FERRY_HOME = join(temp, "home");
const {
	GLOBAL_PROJECT_NAME, applyPull, collectResource, createResourceClient, createResources,
	discoverResources, parseSyncArgs, recoverPull, resourcePath, selectResource, summarizeSkillFiles, textDiff,
} = await import("../lib/resources.mjs");
after(() => rmSync(temp, { recursive: true, force: true }));
function project(name) { const root = join(temp, name); mkdirSync(root, { recursive: true }); return root; }
function file(root, path, text) { mkdirSync(join(root, path, ".."), { recursive: true }); writeFileSync(join(root, path), text); }
function skill(root, text = "hello", name = "research") {
	file(root, `.ferry/skills/${name}/SKILL.md`, `---\nname: ${name}\ndescription: Research\n---\n${text}`);
	file(root, `.ferry/skills/${name}/references/note.md`, "reference");
	return collectResource(root, `.ferry/skills/${name}`).resource;
}
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

test("complete selected skill includes scripts, templates and references and excludes temp/credential files", () => {
	const root = project("collect");
	skill(root);
	file(root, ".ferry/skills/research/scripts/check.py", "print('check')");
	file(root, ".ferry/skills/research/scripts/check.pyc", "bytecode");
	file(root, ".ferry/skills/research/templates/deck.pptx", "pptx-bytes");
	file(root, ".ferry/skills/research/templates/~$deck.pptx", "office-lock");
	file(root, ".ferry/skills/research/.env", "SECRET");
	file(root, "AGENTS.md", "project rules are not part of skill sync");
	file(root, ".ferry/agents/reviewer.md", "agent definition");
	file(root, ".ferry/hooks.json", "{} ");
	const selected = selectResource(root, "research");
	const { resource, skipped } = collectResource(root, selected.path);
	assert.equal(resource.files.length, 4);
	assert.equal(skipped.length, 3);
	assert.ok(!JSON.stringify(resource).includes("SECRET"));
	assert.ok(!JSON.stringify(resource).includes("office-lock"));
	const summary = summarizeSkillFiles(resource.files, selected.path);
	assert.match(summary, /4 个文件.*SKILL\.md.*scripts\/×1.*templates\/×1/);
	assert.equal(selectResource(root, selected.path).path, selected.path);
	file(root, ".claude/skills/research/SKILL.md", "same name");
	assert.throws(() => selectResource(root, "research"), /Ambiguous/);
	file(process.env.FERRY_HOME, "skills/mine/SKILL.md", "user skill");
	assert.equal(selectResource(root, "user:mine").path, ".ferry/skills/mine");
	assert.ok(discoverResources(root).every((r) => r.path.includes("/skills/")));
	assert.throws(() => selectResource(root, "AGENTS.md"), /Only skills/);
	file(root, "custom/other/SKILL.md", "external skill");
	assert.equal(selectResource(root, join(root, "custom/other")).path, ".ferry/skills/other");
	assert.equal(selectResource(root, "custom/other").source, join(root, "custom/other"));
});

test("parseSyncArgs handles install/upload scopes, quoted names and flags", () => {
	assert.deepEqual(parseSyncArgs('upload "my skill" -g'), {
		action: "upload", selector: "my skill", scope: "global", target: undefined, all: false, revision: undefined,
	});
	assert.deepEqual(parseSyncArgs("install hw-ppt --project --revision 3"), {
		action: "install", selector: "hw-ppt", scope: undefined, target: "project", all: false, revision: 3,
	});
	assert.deepEqual(parseSyncArgs("install --global --all"), {
		action: "install", selector: "", scope: undefined, target: "global", all: true, revision: undefined,
	});
	assert.throws(() => parseSyncArgs("install -g -p"), /either --global or --project/);
});

test("unsafe paths, credential files, oversized files and symlinks are rejected", () => {
	for (const path of ["../AGENTS.md", "/AGENTS.md", "C:/AGENTS.md", "a\\b", "a/.env", "a/NUL.md", "a/x."]) assert.throws(() => resourcePath(path));
	const root = project("unsafe");
	skill(root);
	file(root, ".ferry/skills/research/large.bin", Buffer.alloc(16 * 1024 * 1024 + 1));
	assert.throws(() => collectResource(root, ".ferry/skills/research"), /16 MiB/);
	rmSync(join(root, ".ferry/skills/research/large.bin"));
	if (process.platform === "win32") return;
	symlinkSync(join(temp, "home"), join(root, ".ferry/skills/research/link"));
	assert.throws(() => collectResource(root, ".ferry/skills/research"), /Symlinks/);
});

test("resource transport reuses bounded uploader and adapts to company gateway rejection", async () => {
	const root = project("transport"), resource = skill(root, "中".repeat(130000));
	const sent = [], parts = new Map();
	let parsed;
	const client = createResourceClient({ server: "https://ferry.test", token: "secret", chunkBytes: 90000 }, {
		sleep: async () => {},
		fetch: async (url, opts) => {
			assert.equal(opts.headers.Authorization, "Bearer secret");
			sent.push(opts.body.length);
			assert.ok(opts.body.length <= 90000);
			if (opts.body.length > 48000) return new Response("blocked", { status: 403, headers: { "content-type": "text/html" } });
			const u = new URL(url);
			if (u.pathname.includes("/upload/")) {
				parts.set(Number(u.pathname.split("/").at(-1)), opts.body); return json({ ok: true });
			}
			assert.equal(u.pathname, "/v1/ferry/resources/commit");
			assert.equal(opts.body.length, 0);
			parsed = JSON.parse(Buffer.concat([...parts.entries()].sort((a, b) => a[0] - b[0]).map(([, p]) => p)).toString());
			return json({ ok: true, revision: 1 });
		},
	});
	assert.equal((await client.upload("project", 0, [resource])).revision, 1);
	assert.ok(sent.length > 5);
	assert.equal(parsed.put[0].files[0].data, resource.files[0].data);
});

test("pull saves backups, deletes removed files and can recover a process interrupted before state commit", () => {
	const root = project("pull"), dir = join(temp, "pull-state");
	const old = skill(root);
	file(root, ".ferry/skills/research/SKILL.md", "changed");
	rmSync(join(root, ".ferry/skills/research/references/note.md"));
	const next = collectResource(root, old.path).resource;
	applyPull(root, dir, [next], [old], { bases: { [old.path]: old.hash } });
	assert.match(readFileSync(join(root, old.path, "SKILL.md"), "utf8"), /hello/);
	assert.ok(existsSync(join(dir, "backups")));
	const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
	writeFileSync(join(dir, "pending.json"), JSON.stringify({ id: "interrupted", before: old.files, after: next.files }));
	writeFileSync(join(root, old.path, "SKILL.md"), Buffer.from(next.files[0].data, "base64"));
	recoverPull(root, dir);
	assert.match(readFileSync(join(root, old.path, "SKILL.md"), "utf8"), /hello/);
	applyPull(root, dir, [old], [next], state);
	assert.equal(existsSync(join(root, old.path, "references/note.md")), false);
});

test("interrupted pull refuses to overwrite a subsequent local edit", () => {
	const root = project("recover-edit"), dir = project("recover-edit-state"), old = skill(root);
	writeFileSync(join(dir, "pending.json"), JSON.stringify({ id: "interrupted", before: old.files, after: old.files }));
	file(root, old.path + "/SKILL.md", "later local edit");
	assert.throws(() => recoverPull(root, dir), /later local edit/);
	assert.equal(readFileSync(join(root, old.path, "SKILL.md"), "utf8"), "later local edit");
});

test("pull can change a tracked file into a directory and back without deleting untracked files", () => {
	const root = project("reshape"), dir = join(temp, "reshape-state");
	skill(root); file(root, ".ferry/skills/research/example", "old");
	const old = collectResource(root, ".ferry/skills/research").resource;
	rmSync(join(root, old.path, "example")); file(root, old.path + "/example/note.md", "nested");
	const next = collectResource(root, old.path).resource;
	applyPull(root, dir, [next], [old], { bases: {} });
	assert.equal(readFileSync(join(root, old.path, "example"), "utf8"), "old");
	applyPull(root, dir, [old], [next], { bases: {} });
	file(root, old.path + "/example/untracked.md", "keep");
	assert.throws(() => applyPull(root, dir, [next], [old], { bases: {} }), /blocks the pull/);
	assert.equal(readFileSync(join(root, old.path, "example/untracked.md"), "utf8"), "keep");
	assert.equal(readFileSync(join(root, old.path, "example/note.md"), "utf8"), "nested");
});

test("text diff previews actual changed lines without putting file contents in model results", () => {
	const root = project("diff"), a = skill(root, "before");
	const b = skill(root, "after");
	assert.match(textDiff(a, b), /- before\n\+ after/);
});

test("global skill sync works across directories without bind and supports installing to global or current project", async () => {
	const projA = project("proj-a"), projB = project("proj-b");
	// Remove any leftover global skills from earlier tests, then add hw-ppt with scripts and templates.
	rmSync(join(process.env.FERRY_HOME, "skills"), { recursive: true, force: true });
	file(process.env.FERRY_HOME, "skills/hw-ppt/SKILL.md", "---\nname: hw-ppt\ndescription: Slides\n---\nv1");
	file(process.env.FERRY_HOME, "skills/hw-ppt/scripts/build.py", "print('v1')\n");
	file(process.env.FERRY_HOME, "skills/hw-ppt/references/style.md", "red");

	let head = 0;
	let globalBucket = null;
	const store = new Map();
	const notices = [];
	let installChoice = 0; // 0 = global (~/.ferry/skills), 1 = current project (.ferry/skills)
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (url, opts = {}) => {
		const u = new URL(url);
		if (u.pathname.endsWith("/projects") && (!opts.method || opts.method === "GET")) {
			return json({ projects: globalBucket ? [globalBucket] : [] });
		}
		if (u.pathname.endsWith("/projects") && opts.method === "POST") {
			const body = JSON.parse(opts.body);
			globalBucket = { id: "g1", name: body.name };
			return json(globalBucket);
		}
		if (u.pathname.endsWith("/commit")) {
			const change = JSON.parse(opts.body);
			for (const r of change.put ?? []) store.set(r.path, r);
			for (const p of change.delete ?? []) store.delete(p);
			return json({ ok: true, revision: ++head });
		}
		const pathParam = u.searchParams.get("path");
		const list = [...store.values()].map((r) => ({
			...r, files: r.files.map(({ data: _d, ...meta }) => meta),
		}));
		return json({ id: "g1", name: GLOBAL_PROJECT_NAME, revision: head, resources: list, resource: pathParam ? store.get(pathParam) ?? null : undefined });
	};
	try {
		const commands = {}, tools = {};
		const cfg = { server: "http://mock-global", token: "tok" };
		createResources(cfg)({
			registerCommand: (n, def) => { commands[n] = def; },
			registerTool: (def) => { tools[def.name] = def; },
			sendMessage: () => {},
		});
		const makeCtx = (cwd) => ({
			cwd, hasUI: true,
			reload: async () => {},
			ui: {
				select: async (title, options) => {
					if (title.startsWith("选择上传目标空间")) return options[0]; // default global
					if (title.startsWith("选择 Skill 安装位置")) return options[installChoice];
					if (title.startsWith("Skill 文件已更新")) return "取消";
					return options[0]; // confirm sync / first item
				},
				editor: async () => {},
				notify: (msg) => notices.push(msg),
			},
		});

		// 1. Upload global hw-ppt from projA without any /sync bind; scripts/ and references/ are bundled.
		await commands.sync.handler("upload hw-ppt", makeCtx(projA));
		assert.equal(globalBucket?.name, GLOBAL_PROJECT_NAME);
		assert.equal(head, 1);
		const uploaded = store.get(".ferry/skills/hw-ppt");
		assert.equal(uploaded.files.length, 3);
		assert.ok(uploaded.files.some((f) => f.path.endsWith("/scripts/build.py")));

		// 2. Check /sync status from a completely different directory projB: sees built-in + global synced state.
		await commands.sync.handler("status", makeCtx(projB));
		assert.match(notices.at(-1), /hw-ppt：与全局库一致.*scripts\/×1/);

		// 3. Simulate a fresh computer (remove ~/.ferry/skills/hw-ppt) and install to global (~/.ferry/skills) via interactive prompt.
		rmSync(join(process.env.FERRY_HOME, "skills/hw-ppt"), { recursive: true, force: true });
		installChoice = 0;
		await commands.sync.handler("install hw-ppt", makeCtx(projB));
		assert.equal(readFileSync(join(process.env.FERRY_HOME, "skills/hw-ppt/scripts/build.py"), "utf8"), "print('v1')\n");
		assert.equal(existsSync(join(projB, ".ferry/skills/hw-ppt")), false);

		// 4. Also install into current project (.ferry/skills) by picking option 1 in the interactive location selector.
		installChoice = 1;
		await commands.sync.handler("install hw-ppt", makeCtx(projB));
		assert.equal(readFileSync(join(projB, ".ferry/skills/hw-ppt/scripts/build.py"), "utf8"), "print('v1')\n");

		// 5. Edit global hw-ppt while standing in projB and upload again: baseline from globalStateDir avoids false conflict!
		file(process.env.FERRY_HOME, "skills/hw-ppt/scripts/build.py", "print('v2')\n");
		await commands.sync.handler("upload user:hw-ppt -g", makeCtx(projB));
		assert.equal(head, 2);
	} finally { globalThis.fetch = originalFetch; }
});

test("project-scoped sync supports explicit names, approval cancellation, both-side conflict and stale-head failure", async () => {
	const root = project("extension"), selected = skill(root);
	let head = 0, server = null, answer = "确认同步", changeOnConfirm = false;
	const previews = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (url, opts = {}) => {
		const u = new URL(url);
		if (u.pathname.endsWith("/projects")) return json({ projects: [{ id: "p", name: "Project" }] });
		if (u.pathname.endsWith("/commit")) {
			if (Number(u.searchParams.get("base")) !== head) return json({ detail: "Server changed" }, 409);
			server = JSON.parse(opts.body).put[0]; return json({ ok: true, revision: ++head });
		}
		return json({ revision: head, resources: server ? [server] : [], resource: server });
	};
	try {
		const commands = {}, tools = {};
		createResources({ server: "http://mock", token: "a" })({ registerCommand: (n, def) => commands[n] = def, registerTool: (def) => tools[def.name] = def });
		const ctx = { cwd: root, hasUI: true, ui: {
			select: async (title, options) => {
				previews.push(title);
				if (title.startsWith("关联当前")) return options[0];
				if (title.startsWith("将本地")) return "关联";
				if (title.startsWith("选择 Skill 安装位置")) return options[1]; // current project
				if (changeOnConfirm) { head++; changeOnConfirm = false; }
				return answer;
			}, editor: async () => {}, notify: () => {},
		} };
		const exec = (args) => tools.project_resources.execute("id", { scope: "project", ...args }, undefined, undefined, ctx);
		const first = await exec({ action: "upload", selectors: ["research"] });
		assert.equal(first.details.revision, 1);
		assert.ok(!first.content[0].text.includes("description: Research"));
		// Two-sided edit must visibly require conflict approval.
		file(root, selected.path + "/SKILL.md", "local edit");
		server = { ...server, hash: "server edited" }; head++;
		answer = "取消";
		assert.equal((await exec({ action: "upload", selectors: ["research"] })).details.cancelled, true);
		assert.ok(previews.at(-1).includes("需确认覆盖"));
		answer = "确认覆盖或删除"; changeOnConfirm = true;
		const stale = await exec({ action: "upload", selectors: ["research"] });
		assert.equal(stale.isError, true); assert.match(stale.content[0].text, /Server changed/);
		// Direct slash command preserves a selector containing spaces.
		skill(root, "spaces", "my skill");
		answer = "确认同步";
		await commands.sync.handler('upload -p "my skill"', ctx);
		assert.equal(server.path, ".ferry/skills/my skill");
		file(root, server.path + "/SKILL.md", "unsynced local edit");
		answer = "确认覆盖或删除";
		const pulled = await exec({ action: "pull", target: "project", selectors: ["my skill"] });
		assert.deepEqual(pulled.details.pulled, [server.path]);
		assert.match(readFileSync(join(root, server.path, "SKILL.md"), "utf8"), /spaces/);
		server = { ...server, files: server.files.map((f, i) => i ? f : { ...f, data: "Y29ycnVwdA==" }) };
		const corrupt = await exec({ action: "pull", target: "project", selectors: ["my skill"] });
		assert.equal(corrupt.isError, true);
		assert.match(corrupt.content[0].text, /checksum/);
		assert.match(readFileSync(join(root, server.path, "SKILL.md"), "utf8"), /spaces/);
	} finally { globalThis.fetch = originalFetch; }
});

test("real Pi loader sees project and global skills in a new subagent and after reload", async () => {
	const root = project("loader"); skill(root);
	file(process.env.FERRY_HOME, "skills/global-one/SKILL.md", "---\nname: global-one\ndescription: Global skill\n---\nhi");
	const { skillDirs } = await import("../lib/commands.mjs");
	const { DefaultResourceLoader } = await import("@earendil-works/pi-coding-agent");
	const loader = new DefaultResourceLoader({ cwd: root, agentDir: join(temp, "pi"), noExtensions: true,
		noPromptTemplates: true, noThemes: true, additionalSkillPaths: skillDirs(root) });
	await loader.reload();
	assert.equal(loader.getSkills().skills.find((s) => s.name === "research")?.filePath, join(root, ".ferry/skills/research/SKILL.md"));
	assert.equal(loader.getSkills().skills.find((s) => s.name === "global-one")?.filePath, join(process.env.FERRY_HOME, "skills/global-one/SKILL.md"));
	skill(root, "updated");
	await loader.reload();
	assert.ok(loader.getSkills().skills.some((s) => s.name === "research"));
});

test("local.md and *.local.json workspace profiles are skipped on upload and preserved on install", () => {
	const root = project("local-profile");
	skill(root, "v1", "patent-idea");
	file(root, ".ferry/skills/patent-idea/references/guide.md", "shared guide");
	file(root, ".ferry/skills/patent-idea/references/local.md", "D:/Private/MyKB");
	file(root, ".ferry/skills/patent-idea/config.local.json", "{\"kb\":\"D:/Private\"}");

	const { resource: collected, skipped } = collectResource(root, ".ferry/skills/patent-idea");
	const paths = collected.files.map((f) => f.path);
	assert.ok(paths.includes(".ferry/skills/patent-idea/SKILL.md"));
	assert.ok(paths.includes(".ferry/skills/patent-idea/references/guide.md"));
	assert.ok(!paths.some((p) => p.includes("local.md") || p.includes(".local.json")));
	assert.equal(skipped.length, 2);

	// Simulate /sync install updating SKILL.md from v1 -> v2 while references/local.md exists on disk.
	const updatedRemote = {
		...collected,
		files: collected.files.map((f) => f.path.endsWith("SKILL.md")
			? { ...f, data: Buffer.from("---\nname: patent-idea\ndescription: v2\n---\nv2").toString("base64") }
			: f),
	};
	applyPull(root, join(temp, "local-profile-state"), [collected], [updatedRemote], { bases: {} });
	assert.match(readFileSync(join(root, ".ferry/skills/patent-idea/SKILL.md"), "utf8"), /v2/);
	assert.equal(readFileSync(join(root, ".ferry/skills/patent-idea/references/local.md"), "utf8"), "D:/Private/MyKB");
	assert.equal(readFileSync(join(root, ".ferry/skills/patent-idea/config.local.json"), "utf8"), "{\"kb\":\"D:/Private\"}");
});
