#!/usr/bin/env node
// Fast, zero-dependency validator for Agent Skills (agentskills.io + Ferry portability checks).
// Usage: node validate_skill.mjs <skill-dir> [more-skill-dirs...]
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const ALLOWED_KEYS = new Set(["name", "description", "license", "allowed-tools", "metadata", "compatibility"]);
const EXCLUDED_LOCAL = new Set(["local.md", "local.json", ".local", ".ds_store"]);
const PRIVATE_PATH_RE = /(?:[A-Za-z]:\\Users\\(?!<|\.\.\.)[A-Za-z0-9._-]+\\[^\s"'`]+|\/Users\/(?!<|\.\.\.)[A-Za-z0-9._-]+\/[^\s"'`]+|\/home\/(?!<|\.\.\.)[A-Za-z0-9._-]+\/[^\s"'`]+)/g;

function parseFrontmatter(text) {
	const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
	if (!m) return { error: "Missing or malformed YAML frontmatter (--- ... ---)" };
	const map = {};
	let currentTop = null;
	for (const rawLine of m[1].split(/\r?\n/)) {
		if (!rawLine.trim() || rawLine.trimStart().startsWith("#")) continue;
		if (/^\s+/.test(rawLine)) {
			if (currentTop === "metadata") {
				const sub = /^\s+([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(rawLine);
				if (sub) {
					map.metadata = typeof map.metadata === "object" && map.metadata ? map.metadata : {};
					map.metadata[sub[1]] = sub[2].trim().replace(/^(['"])([\s\S]*)\1$/, "$2");
				}
			} else if (currentTop && typeof map[currentTop] === "string") {
				map[currentTop] = `${map[currentTop]} ${rawLine.trim()}`.trim();
			}
			continue;
		}
		const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(rawLine);
		if (!kv) return { error: `Cannot parse frontmatter line: ${rawLine}` };
		currentTop = kv[1];
		const val = kv[2].trim();
		map[currentTop] = val === ">" || val === ">-" || val === "|" ? "" : val.replace(/^(['"])([\s\S]*)\1$/, "$2");
	}
	return { data: map, body: text.slice(m[0].length) };
}

function walkFiles(dir, out = []) {
	for (const entry of readdirSync(dir)) {
		if (entry === ".git" || entry === "node_modules" || entry === "__pycache__" || EXCLUDED_LOCAL.has(entry.toLowerCase())) continue;
		const full = join(dir, entry);
		const st = statSync(full);
		if (st.isDirectory()) walkFiles(full, out);
		else if (st.isFile()) out.push({ path: full, size: st.size });
	}
	return out;
}

export function validateSkillDir(dirPath) {
	const dir = resolve(dirPath);
	const folderName = basename(dir);
	const issues = [];
	const fail = (msg) => issues.push({ level: "FAIL", msg });
	const warn = (msg) => issues.push({ level: "WARN", msg });

	const skillMd = join(dir, "SKILL.md");
	if (!existsSync(skillMd)) {
		fail("SKILL.md not found in skill directory.");
		return issues;
	}

	const raw = readFileSync(skillMd, "utf8");
	const lines = raw.split(/\r?\n/);
	if (lines.length > 500) warn(`SKILL.md is ${lines.length} lines (keep under 500 lines; move details to references/).`);

	const parsed = parseFrontmatter(raw);
	if (parsed.error) {
		fail(parsed.error);
		return issues;
	}
	const fm = parsed.data;
	for (const k of Object.keys(fm)) {
		if (!ALLOWED_KEYS.has(k)) fail(`Unexpected frontmatter key '${k}' (allowed: ${[...ALLOWED_KEYS].join(", ")}).`);
	}

	const name = String(fm.name ?? "").trim();
	if (!name) fail("Missing required 'name' in frontmatter.");
	else {
		if (!/^[a-z0-9-]+$/.test(name) || name.startsWith("-") || name.endsWith("-") || name.includes("--")) {
			fail(`Invalid skill name '${name}': use lowercase letters, digits, and single hyphens only.`);
		}
		if (name.length > 64) fail(`Skill name '${name}' exceeds 64 characters (${name.length}).`);
		if (name !== folderName) fail(`Frontmatter name '${name}' does not match directory name '${folderName}'.`);
	}

	const desc = String(fm.description ?? "").trim();
	if (!desc) fail("Missing required 'description' in frontmatter.");
	else {
		if (desc.length > 1024) fail(`Description exceeds 1024 characters (${desc.length}).`);
		if (desc.includes("<") || desc.includes(">")) fail("Description must not contain '<' or '>'.");
		if (desc.includes("→") || /->/.test(desc)) {
			warn("Description contains workflow arrows ('→' / '->'); avoid summarizing workflow steps in description so agents read SKILL.md.");
		}
	}

	// Check local relative file paths referenced in SKILL.md (must end in a file extension; skip illustrative foo/bar/xx placeholders)
	const relMatches = parsed.body.matchAll(/(?<![/\w~.-])((?:scripts|references|examples|templates)\/[A-Za-z0-9_\u4e00-\u9fa5./-]+\.[A-Za-z0-9]{1,6})(?=[`\s)"'，。；：,.;:\]|]|$)/g);
	const checkedRefs = new Set();
	for (const m of relMatches) {
		const rel = m[1].replace(/[.,;:]+$/, "");
		if (checkedRefs.has(rel) || rel.endsWith("/local.md") || /\/(foo|bar|baz|xx|example)\./i.test(rel)) continue;
		checkedRefs.add(rel);
		if (!existsSync(join(dir, rel))) {
			fail(`Referenced relative path '${rel}' in SKILL.md does not exist in ${folderName}/.`);
		}
	}

	// Scan text files for hardcoded private user paths, and binary files outside templates/samples for leftover outputs
	for (const f of walkFiles(dir)) {
		const rel = f.path.slice(dir.length + 1).replaceAll("\\", "/");
		if (/\.(md|py|mjs|js|sh|ps1|json|ya?ml)$/i.test(rel)) {
			const content = readFileSync(f.path, "utf8");
			const hits = [...content.matchAll(PRIVATE_PATH_RE)].map((x) => x[0])
				.filter((p) => !p.includes("/Users/<") && !p.includes("C:\\Users\\<") && !rel.endsWith("validate_skill.mjs"));
			if (hits.length) warn(`${rel} contains machine-specific user path(s): ${hits.slice(0, 2).join(", ")}`);
		}
		if (/\.(pptx|docx|pdf|xlsx)$/i.test(rel) && !/^(templates|references|assets|examples)\//i.test(rel)) {
			warn(`${rel} (${Math.round(f.size / 1024)} KB) looks like a generated Office/PDF artifact outside templates/.`);
		}
	}
	return issues;
}

if (import.meta.url === `file://${resolve(process.argv[1] ?? "")}` || process.argv[1]?.endsWith("validate_skill.mjs")) {
	const targets = process.argv.slice(2);
	if (!targets.length) {
		console.error("Usage: node validate_skill.mjs <skill-dir> [more-skill-dirs...]");
		process.exit(2);
	}
	let hasFail = false;
	for (const t of targets) {
		const issues = validateSkillDir(t);
		const fails = issues.filter((i) => i.level === "FAIL");
		const warns = issues.filter((i) => i.level === "WARN");
		if (fails.length) hasFail = true;
		console.log(`[${basename(resolve(t))}] FAIL=${fails.length} WARN=${warns.length}`);
		for (const item of issues) console.log(`  ${item.level}: ${item.msg}`);
	}
	process.exit(hasFail ? 1 : 0);
}
