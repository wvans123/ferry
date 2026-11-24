---
name: skill-creator
description: Create a new skill or refine an existing skill from user instructions or the current conversation workflow, then validate its structure, triggers, relative links and privacy before local use or /sync upload. Use when the user asks to create, turn a workflow into, refactor, slim down, lint, or optimize a SKILL.md or skill folder.
---
# Creating & Refining Skills (Lightweight)

Package repeatable workflows, domain conventions, and deterministic scripts into a clean skill directory (`~/.ferry/skills/<name>/` for cross-project use, or `.ferry/skills/<name>/` for one project) without bloat or rigid over-constraints.

## 1. Capture intent from real work (do not invent rigid rules)

- **From an active conversation**: When the user says "turn what we just did into a skill" or "update skill X", extract the real sequence of steps, tools, and user corrections from this session. If you wrote a reusable parser, generator, or linter during the session, move it into `scripts/`.
- **From scratch**: Clarify in 1 short round (via `ask_user` if needed): target scope (global `~/.ferry/skills` vs project `.ferry/skills`), concrete user phrases that should trigger it, adjacent skills it must *not* collide with, and whether outputs have deterministic checks worth scripting.
- **Generalize naturally**: Explain *why* important rules exist instead of stacking rigid boilerplate `MUST` gates. Distinguish domain variants (for example, qualitative architecture work vs quantitative performance work) rather than forcing one template onto every case.

## 2. Three-tier progressive disclosure structure

```text
<skill-name>/
├── SKILL.md          # Required: frontmatter + core workflow (< 500 lines; aim for 60–150)
├── scripts/          # Optional: deterministic checks/builders (0 context cost until run)
├── references/       # Optional: domain variants or deep specs loaded only when needed
├── examples/         # Optional: one complete, runnable example per major scenario
└── templates/        # Optional: clean starter Office/SVG/config assets
```

### Frontmatter (`name`, `description`, optional `metadata.onboarding`)
- **`name`**: Lowercase letters, digits, and hyphens only (`^[a-z0-9-]+$`, `<= 64` chars), matching the folder name.
- **`description`** (`<= 1024` chars, no `<` or `>`): This is what the model sees on every turn to decide activation.
  1. State clearly what scenarios and concrete user phrases trigger the skill.
  2. Add **negative boundaries** against sibling skills (`"... Use X instead when ..."`).
  3. **Do not put a step-by-step workflow summary (`Step 1 -> Step 2 -> ...`) in `description`**, otherwise fast models follow the summary shortcut instead of reading `SKILL.md`.
- **`metadata.onboarding`** (optional): For domain skills that can use a user's local background knowledge base (standards, prior docs, templates), add a short friendly one-line `onboarding` under `metadata:`. Ferry shows it once after `/sync install` on a new computer that has no `~/.ferry/local.md` yet:
  - Support an optional one-time "scan & index my local knowledge base into `~/.ferry/local.md`" action (and when updating an existing user KB later, strictly follow its folder layout and naming habits without dumping raw files).
  - Always work cleanly with **zero setup** too: rely on the agent's own search and maintain a tidy `./知识库/` folder in the current project when no external KB is bound.

### Body & bundled scripts
- **Single-hop references**: Link directly from `SKILL.md` to `references/foo.md` or `examples/bar.md`. Avoid `A -> B -> C` chains that waste turns.
- **Explicit script interpreters**: Write `python -X utf8 ...` or `node ...` in commands rather than bare `./script.sh` so Windows and stripped-permission filesystems work reliably. Scripts should print progress notes to `stderr` and compact structured output to `stdout` (with output truncation or caching where helpful so context stays lean).
- **Keep skills portable & de-privatized**: Never hardcode personal names, employee IDs, tokens, or machine-specific paths (`C:\Users\...`, `/Users/...`) inside synced skill files. Machine-local paths belong in `~/.ferry/local.md` or `references/local.md` (both are automatically skipped by `/sync upload` and preserved by `/sync install`).

## 3. Validate & review before finishing

1. **Run the built-in static validator** on the skill directory and fix every `FAIL` (and review any `WARN`):
   ```bash
   node "<this-skill-dir>/scripts/validate_skill.mjs" "<target-skill-dir>"
   ```
2. **Check sibling collisions & over-constraints**: Compare `description` against loaded skills (`/skills` or `~/.ferry/skills/*`). For major edits to an existing workflow skill, optionally call `advisor` (if available) or `review` once to verify no useful capability was lost and no unnatural constraint was introduced.
3. **Sync**: Remind the user they can run `/sync upload <skill-name>` to publish the updated skill folder (including `scripts/`, `references/`, `templates/`) to their global skill library.
