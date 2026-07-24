---
name: deep-understanding
kind: technique
description: "A reusable technique for building a deep, structured understanding of a scientific input — surface the core claim, hidden assumptions, the entities and their relations, and what is genuinely unknown."

vars: []
capabilities: []
---
# Technique: Deep Understanding

First gauge the size of the input set: how many attachments arrived with the prompt, what kind
each one is, and roughly how much material each contains. Then, before producing any output, use
this procedure to make sure you actually understand the material — not just its surface wording.

1. **Restate** the central idea or question in one sentence, in your own words. If you cannot,
   you have not understood it yet — re-read.
2. **Entities & relations** — list the key entities (concepts, methods, objects, quantities) and
   the relations between them (causes, depends-on, measured-by, part-of). Note any relation that
   is implied but never stated.
3. **Assumptions** — make every hidden assumption explicit. What must be true for the idea to
   make sense? What is the author taking for granted?
4. **Known vs. open** — separate what is already established from what is genuinely uncertain.
   Mark each item `known` or `open`.
5. **Ambiguities** — flag anything that could be read two ways; state the reading you adopt and why.

Carry the result of this procedure into your main task. It is private working material — do not
include it in your structured output unless your task explicitly asks for it.
