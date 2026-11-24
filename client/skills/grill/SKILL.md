---
name: grill
description: Walk the decision tree with the user via ask_user until every open branch is settled and zero hidden assumptions remain. Use when starting a new project, shaping a patent idea (SA, RAN, algorithm or system), 3GPP CR/TDoc, report or slide deck with open choices, planning a non-trivial refactor, or whenever the user says "grill me" / "拷问我" / "挑刺" / "帮我想清楚" or runs /grill.
---
# Grill (decision-tree alignment before building)

Treat an open idea, patent concept, contribution, deck, or architecture as a **decision tree**: root choices unlock dependent child choices. Resolve the frontier round by round so nothing is built on hidden assumptions.

## How to run a Grill session

1. **Investigate facts yourself first; decisions belong to the user**
   - Spend 1 to 2 batched turns checking workspace files, standards clauses, existing patents/notes, or code (`ls`, `find`, `grep`, `read`, `office_read` with `outline: true`, or `task` with `explore`).
   - Never ask the user a factual question the files or standards already answer.

2. **Ask only the current frontier via `ask_user`**
   - The **frontier** is the set of open decisions whose prerequisites are already settled (you do not have to guess another answer in the same batch to phrase them).
   - Call `ask_user` with **2 to 4 frontier questions** per round:
     - Provide 2 to 5 concrete options per question with a brief trade-off `description`.
     - Mark your `recommended` option (grounded in what you inspected) so accepting the default takes one press of Enter.
   - When the user answers, update the decision tree: settled branches unlock the next frontier. Run another short `ask_user` round only if genuine downstream forks remain; stop as soon as remaining details have obvious defaults.

3. **Challenge weak assumptions constructively**
   - If the user pushes back or proposes an idea with a prior-art overlap or missing link, test it against concrete facts: explain what holds up, pinpoint the exact step that breaks, and offer 2 to 3 concrete ways to fix it.

4. **Summarize & hand off before executing**
   - Do not write final deliverables while grilling.
   - When the frontier is empty, output a compact summary:
     - **Agreed decisions** (one line each);
     - **Deferred / out-of-scope items** (if any);
     - **Next step / target skill** (e.g. `patent-idea`, `sa-tdoc-writing`, `hw-ppt`, or direct implementation), then proceed if the user asked you to build.

## Scenario checklists (pick only what applies)

### Patent Idea (3GPP SA / RAN / Algorithm / System)
- **Bottleneck**: Which exact step of which existing procedure/pipeline gets stuck (missing state/signaling context for architecture patents, or concrete latency/resource limits for performance patents)?
- **Simple workarounds**: What are the 2 most obvious fixes a skilled engineer would try first, and why does each fail?
- **Target entity & mechanism**: Which network element, protocol layer (PHY/MAC/RRC/CN), or system module is enhanced, what new signaling/IE/criterion/operator is added, and what fallback runs when it is absent?
- **External detectability**: If internal logic is swapped for another algorithm, does external signaling, message timing, or observable I/O still change? (If not, move the main claim to observable interaction or dual-side pipeline steps.)
- **Prior-art boundary**: How does this differ from our existing patents/IDEAs or recent standard solutions?

### 3GPP Contribution (SA2 / SA6 / RAN pCR or TDoc)
- Which KI / open issue / Editor's Note does this solve, and is it a new solution, update, or evaluation?
- Which parts belong to another WG (e.g. SA2 vs SA6 vs SA3) and should be stated as dependencies or ENs rather than designed here?
- Which rival company solutions conflict with this, why would they object, and what is our fallback compromise (e.g. NOTE / optional IE)?

### Presentation / Executive Report
- Who is the audience, and what decision or takeaway should they leave with?
- What is the one-sentence headline conclusion and the primary figure backing it?
- What is internal-only (watch-items, tactics, unverified drafts) and must stay out of external slides?

### Software / Project Structure
- Target user workflow, explicit non-goals, module/folder boundaries, data/API contracts, and verification command.
