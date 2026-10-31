// Ferry as a member of a Paperclip team (https://github.com/paperclipai/paperclip).
//
// Paperclip is the team's board: roles, an org chart, tasks, comments, and a dashboard. It wakes an agent for a
// "heartbeat" and runs it with its pi adapter; with `command` set to ferry, every member is a Ferry agent, so its model
// calls go through your Ferry server like any other. Paperclip passes the run's identity in PAPERCLIP_* variables.
//
//   team tool           the board without curl: see your work and the team, read a task, take it, comment,
//                       change its status, create a task for another member (tasks and comments are how members
//                       hand work to each other and talk)
//   ferry team ...      add Ferry members to a Paperclip company from the command line (see teamCli)
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

const env = () => ({
	url: (process.env.PAPERCLIP_API_URL ?? "").replace(/\/+$/, "").replace(/\/api$/, ""),
	key: process.env.PAPERCLIP_API_KEY ?? "",
	agent: process.env.PAPERCLIP_AGENT_ID ?? "",
	company: process.env.PAPERCLIP_COMPANY_ID ?? "",
	run: process.env.PAPERCLIP_RUN_ID ?? "",
	task: process.env.PAPERCLIP_TASK_ID ?? "",
});

export const inPaperclip = () => Boolean(process.env.PAPERCLIP_API_URL && process.env.PAPERCLIP_API_KEY);

async function api(method, path, body, { url, key, run } = env()) {
	const res = await fetch(`${url}/api${path}`, {
		method,
		headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(run ? { "X-Paperclip-Run-Id": run } : {}) },
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: AbortSignal.timeout(30000),
	});
	const text = await res.text();
	let json = null;
	try {
		json = JSON.parse(text);
	} catch {
		// not JSON
	}
	if (!res.ok) throw new Error(`Paperclip ${method} ${path}: HTTP ${res.status} ${json?.error ?? text.slice(0, 300)}`);
	return json;
}

const list = (x) => (Array.isArray(x) ? x : x?.items ?? x?.issues ?? x?.agents ?? x?.comments ?? x?.data ?? []);
const ref = (i) => i.identifier ?? i.key ?? i.id;
const line = (i) => `- ${ref(i)} [${i.status}] ${i.title}${i.assigneeAgentId ? "" : i.assigneeUserId ? " (a person)" : ""}${i.id !== ref(i) ? ` (id ${i.id})` : ""}`;

/** Who is on the team: name, title, status, id. */
async function members() {
	const { company } = env();
	return list(await api("GET", `/companies/${company}/agents`));
}

async function agentId(name) {
	if (!name) return undefined;
	const all = await members();
	const n = String(name).toLowerCase().replace(/^@/, "");
	const a = all.find((x) => [x.id, x.name, x.urlKey, x.shortname, x.title].some((v) => v && String(v).toLowerCase() === n));
	if (!a) throw new Error(`No team member called "${name}". Members: ${all.map((x) => x.name).join(", ")}`);
	return a.id;
}

const ACTIONS = ["board", "read", "take", "comment", "update", "create"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Paperclip wants ids where tasks link to tasks; the model may give an identifier like LAB-3. */
const issueId = async (x) => (UUID.test(String(x)) ? x : (await api("GET", `/issues/${x}`)).id);

export function createTeam() {
	return (pi) => {
		if (!inPaperclip()) return;
		pi.on("before_agent_start", (event) => {
			const { task } = env();
			return { systemPrompt: `${event.systemPrompt}\n\n<ferry_team>\nYou are a member of a team run on Paperclip, the team's ` +
				"board of tasks and comments. Use the `team` tool for the board (it adds the right headers; no need for curl): " +
				"`board` shows your assigned work and the members, `read` a task with its comments, `take` it before working " +
				"on it, `comment` to report progress or ask a member something (mention them as @name), `update` its status " +
				"(done when finished and checked, blocked with the reason), and `create` a task assigned to another member to " +
				"hand them work; with wait: true your task waits for it and you are woken when it is done (no need to check " +
				"back). Put results where the task asks, and say in your final comment where they are. Before you finish, " +
				"always leave your task in a clear state: done (finished and checked), blocked (waiting for other tasks, " +
				"set by wait or blocked_by), or in_review; otherwise Paperclip has to come back and ask." +
				(task ? `\nThis run was started for task ${task}.` : "") + "\n</ferry_team>" };
		});

		pi.registerTool({
			name: "team",
			label: "Team board",
			description: "The team's Paperclip board. action: board (your work and the members) | read (a task and its comments) | " +
				"take (claim a task before working on it) | comment | update (status and/or comment; blocked_by to wait for " +
				"tasks) | create (a new task, usually for another member; it becomes part of your current task; wait: true to " +
				"wait for it).",
			promptSnippet: "team: the team board (Paperclip): your tasks, comments, handing work to other members",
			parameters: Type.Object({
				action: StringEnum(ACTIONS),
				task: Type.Optional(Type.String({ description: "Task id or identifier (read, take, comment, update; parent for create)" })),
				text: Type.Optional(Type.String({ description: "Comment text (comment, update) or the task description (create)" })),
				status: Type.Optional(StringEnum(["todo", "in_progress", "in_review", "blocked", "done", "cancelled"])),
				title: Type.Optional(Type.String({ description: "Title of the new task (create)" })),
				assignee: Type.Optional(Type.String({ description: "Member name for the new task (create), e.g. Researcher" })),
				parent: Type.Optional(Type.String({ description: "Parent task (create); defaults to the task this run is for" })),
				wait: Type.Optional(Type.Boolean({ description: "create: the parent task waits for the new one (set to blocked by it); you are woken when it is done" })),
				blocked_by: Type.Optional(Type.Array(Type.String(), { description: "update: tasks this one waits for (sets status blocked)" })),
			}),
			async execute(_id, p) {
				const e = env();
				const out = (text) => ({ content: [{ type: "text", text }], details: undefined });
				const need = (k) => {
					if (!p[k]) throw new Error(`"${k}" is needed for ${p.action}`);
					return p[k];
				};
				switch (p.action) {
					case "board": {
						const [mine, team] = await Promise.all([api("GET", "/agents/me/inbox-lite").catch(() => null), members()]);
						const work = list(mine);
						return out(`Your work:\n${work.length ? work.map(line).join("\n") : "- nothing assigned"}\n\nMembers:\n` +
							team.map((a) => `- ${a.name}${a.title ? ` (${a.title})` : ""} [${a.status ?? "?"}]${a.id === e.agent ? " <- you" : ""}`).join("\n"));
					}
					case "read": {
						const id = need("task");
						const [issue, comments] = await Promise.all([api("GET", `/issues/${id}`), api("GET", `/issues/${id}/comments`).catch(() => [])]);
						const cs = list(comments).slice(-20).map((c) => `[${c.authorAgentName ?? c.authorName ?? c.authorAgentId ?? c.authorUserId ?? "?"}] ${c.body}`);
						return out(`${line(issue)}\n\n${issue.description ?? ""}\n\nComments:\n${cs.join("\n\n") || "(none)"}`.slice(0, 20000));
					}
					case "take": {
						const issue = await api("POST", `/issues/${need("task")}/checkout`, {
							agentId: e.agent, expectedStatuses: ["todo", "backlog", "blocked", "in_review", "in_progress"] });
						return out(`Taken: ${line(issue ?? { id: p.task, status: "in_progress", title: "" })}`);
					}
					case "comment":
						await api("POST", `/issues/${need("task")}/comments`, { body: need("text") });
						return out("Comment added.");
					case "update": {
						const body = { ...(p.status ? { status: p.status } : {}), ...(p.text ? { comment: p.text } : {}),
							...(p.blocked_by?.length ? { blockedByIssueIds: await Promise.all(p.blocked_by.map(issueId)), status: "blocked" } : {}) };
						const issue = await api("PATCH", `/issues/${need("task")}`, body);
						return out(`Updated: ${line(issue ?? { id: p.task, status: p.status, title: "" })}`);
					}
					case "create": {
						const given = p.parent ?? p.task ?? e.task;
						const parent = given ? await issueId(given) : "";
						const issue = await api("POST", `/companies/${e.company}/issues`, {
							title: need("title"), description: p.text ?? "", status: "todo",
							...(p.assignee ? { assigneeAgentId: await agentId(p.assignee) } : {}),
							...(parent ? { parentId: parent } : {}) });
						let waiting = "";
						if (p.wait && parent) {
							const cur = await api("GET", `/issues/${parent}`).catch(() => ({}));
							const before = (cur.blockedBy ?? []).map((b) => b.id ?? b).filter(Boolean);
							await api("PATCH", `/issues/${parent}`, { status: "blocked", blockedByIssueIds: [...new Set([...before, issue.id])] });
							waiting = `\nYour task ${cur.identifier ?? parent} now waits for it (blocked); you will be woken when it is done.`;
						}
						return out(`Created: ${line(issue)}${p.assignee ? ` for ${p.assignee}` : ""}${waiting}`);
					}
					default:
						throw new Error(`Unknown action ${p.action}`);
				}
			},
		});
	};
}
