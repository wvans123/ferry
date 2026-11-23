---
name: grill
description: Interview the user to align on project structure, architecture, scope, document/deck outline, or ambiguous design decisions before building. Use when starting a new project, shaping a specification, 3GPP CR, report or presentation with open structure, planning a non-trivial refactor, or whenever the user says "grill me" or runs /grill.
---
# Grill (align before building)

Resolve ambiguity upfront so you build the right thing on the first pass instead of guessing architecture, folder layout, or deliverable structure.

## Workflow

1. **Inspect first, never ask lazy questions**
   - Spend 1 to 2 batched turns checking what the workspace already answers (`ls`, `find`, `grep`, `read`, `office_read` with `outline: true`).
   - Never ask the user something a file in the project already states.

2. **Map the unresolved decision tree**
   - Group open choices in dependency order:
     - **Outcome & scope**: target reader/user, must-haves, explicit non-goals.
     - **Structure**: project folder/module layout, architecture boundaries, or document/slide outline.
     - **Details & constraints**: interfaces, data shapes, formats, compatibility, edge cases.
     - **Verification**: how completion will be checked.

3. **Interview in focused `ask_user` batches**
   - Ask 2 to 4 high-impact questions per `ask_user` call (never one trivial question per turn).
   - Give 2 to 5 concrete options per question, a short `description` of the trade-off on each option, and mark your `recommended` choice based on what you read.
   - Settle foundational branches (scope, layout, architecture) first. If an answer opens a genuine downstream fork, run one short follow-up `ask_user` call; stop asking as soon as remaining details have obvious defaults.

4. **Lock alignment, then execute**
   - Do not create or edit project deliverables while interviewing.
   - Once key choices are settled, state the agreed structure and defaults in a few compact lines, then build (or stop there if the user asked only for a plan).
