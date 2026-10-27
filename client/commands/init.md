---
description: Study this project and write AGENTS.md, the instructions every later conversation starts with
argument-hint: "[anything to emphasise]"
---
Study this project and create (or improve) the file AGENTS.md in the project folder. Every later conversation in
this folder starts with its content, so it should hold what an agent new to the project needs and cannot quickly
guess. ${@:-}

1. Look around first: the README, build and package files (package.json, pom.xml, build.gradle, *.csproj,
   pyproject.toml, Makefile, CMakeLists.txt...), the folder layout, CI files, existing AGENTS.md / CLAUDE.md /
   .cursor/rules / .github/copilot-instructions.md, and a few typical source files. Use the task tool with the
   explore agent for a wide look if the project is big.
2. Write AGENTS.md with short sections:
   - What the project is, in two or three sentences.
   - How to build, run, test and lint, with the exact commands (and how to run a single test).
   - The layout: the important folders and what lives where.
   - Conventions that are not obvious from one file: code style, naming, error handling, how modules talk to
     each other, generated files that must not be edited by hand.
   - Pitfalls: things that look right but break something.
3. Keep it under about 150 lines. No generic advice ("write clean code"), nothing that is obvious from the code.
4. If AGENTS.md already exists, keep what is still true, fix what is wrong, and add what is missing.
Show me a short summary of what you wrote at the end.
