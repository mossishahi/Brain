---
name: field-match
kind: technique
description: "Decide whether any name in a list of candidate scientific fields denotes the same field as a given field name — answering none when no candidate is an exact conceptual match. The matching decision of the taxonomy NA-resolution flow: judged on meaning alone, on candidate names alone, with no scores or retrieval metadata."
vars: [query, options]
capabilities: []
---
# Technique: Field Match

You are given the name of a scientific field, and a list of candidate field names.
Decide which single candidate — if any — denotes **the same field**. "None" is a
valid and common answer; do not force a choice.

## Input

- `query` — the scientific field name: {{query}}
- `options` — the candidate field names, listed alphabetically:

{{options}}

## What "the same field" means

Two names denote the same field when both directions of this test hold:

> A researcher who describes their expertise as *query* would be correctly described
> as working in *candidate* — **and** a researcher in *candidate* would be correctly
> described as working in *query*.

Judge this on what the fields are — their object of study and their methods — never
on the words the names share.

- **Decoration does not change a field.** Catalogue qualifiers ("Advanced …",
  "… Techniques", "… and Applications", "… Research") and equivalent compound forms
  of the standard name are the same field. *Number Theory* matches
  *Algebra and Number Theory*.
- **A broader field is not the same field.** *Organic Chemistry* does not match
  *Chemistry*: the second direction of the test fails.
- **A narrower or applied variant is not the same field.** *Photovoltaics* does not
  match *Photovoltaics in Buildings*; the applied variant excludes most of the
  field's researchers.
- **A word shared across disciplines means nothing.** *Cell Biology* and *Cell
  Networks* (telecommunications) share a word and no subject matter. When a
  candidate's plain reading belongs to a different discipline than the query, it is
  not a match regardless of how similar the names look.
- **Paired names can still be the same field.** Some catalogues name a field
  together with its inseparable counterpart ("X and Y"). This is a match only if
  researchers in *query* are, as a community, the researchers of that paired area —
  not merely overlapping with it.

## Procedure

1. State to yourself what research is done under `query`: its object of study and
   its methods.
2. Apply the two-direction test to every option. Do not stop at the first plausible
   candidate; a later option may be the exact one.
3. If exactly one option passes, that is the match. If several pass, they are
   near-duplicates — choose the one whose scope matches the query most closely.
4. If none passes, answer none. An honest none is always better than the
   least-wrong option: a wrong match silently misfiles every future use of this
   field name.

## Output

Return exactly one JSON object and nothing else:

```json
{ "match": "<the matching option, verbatim, or null>", "reason": "<one or two sentences applying the test>" }
```
