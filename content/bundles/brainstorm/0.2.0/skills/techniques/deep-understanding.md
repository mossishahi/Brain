---
name: deep-understanding
kind: technique
description: "A reusable technique for building a deep, structured understanding of a scientific input — surface the core claim, hidden assumptions, the entities and their relations, what is genuinely unknown, and, when source code implementing the idea is attached, a conceptual map of its main modules."

vars: []
capabilities: [attachment-access]
---
# Technique: Deep Understanding

First gauge the size of the input set: how many attachments arrived with the prompt, what kind
each one is (including whether it is source code), and roughly how much material each contains.
Then, before producing any output, use this procedure to make sure you actually understand the
material — not just its surface wording.

1. **Restate** the central idea or question in one sentence, in your own words. If you cannot,
   you have not understood it yet — re-read.
2. **Entities & relations** — list the key entities (concepts, methods, objects, quantities) and
   the relations between them (causes, depends-on, measured-by, part-of). Note any relation that
   is implied but never stated.
3. **Code map** — if the input set includes attached source code that implements the idea, method,
   or experiment under study (the submitter's own code, or a runnable implementation of a proposed
   or referenced method), read the relevant files through your attachment-access capability and
   turn the code into a conceptual map: the main modules (files, classes, or packages — whichever
   grouping the codebase actually uses), each module's responsibility in one line, and the relations
   between them (calls, imports, data/control flow, depends-on). Read for structure, not
   exhaustively — prioritize the files that carry the core logic and skip boilerplate, generated, or
   dependency/config files. Reconcile the map against Step 2: which described entities are actually
   implemented, which are only partially implemented, and which appear in the code but were never
   mentioned in the prompt. Skip this step, without fabricating a map, when no attachment is source
   code.
4. **Assumptions** — make every hidden assumption explicit. What must be true for the idea to
   make sense? What is the author taking for granted?
5. **Known vs. open** — separate what is already established from what is genuinely uncertain.
   Mark each item `known` or `open`.
6. **Ambiguities** — flag anything that could be read two ways; state the reading you adopt and why.

Carry the result of this procedure into your main task. It is private working material — do not
include it in your structured output unless your task explicitly asks for it.
