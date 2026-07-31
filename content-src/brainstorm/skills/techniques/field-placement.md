---
name: field-placement
kind: technique
description: "Given a scientific field name and the complete current taxonomy (four levels, names only), produce the field's canonical name and the existing node it should be injected under — without adding a level. The naming-and-placement decision of the taxonomy NA-resolution flow, invoked only after field-match answered that no candidate matches."
vars: [query, taxonomy]
capabilities: []
---
# Technique: Field Placement

A scientific field has no node in the taxonomy below. Name it canonically and choose
where it belongs. Your answer becomes a permanent node, so decide as a curator of a
reference catalogue, not as a matcher of strings.

## Input

- `query` — the field name as it was encountered: {{query}}
- `taxonomy` — the complete current taxonomy as an indented outline. Indentation
  encodes the four levels: domain, field, subfield, topic. This is the whole,
  latest catalogue — everything that exists is in it, and nothing else exists:

{{taxonomy}}

## Procedure

**1. Name the field — generic but exact.**
- Use the name the field's research community itself uses: the name of its
  conferences, journals, textbooks and survey titles.
- Prefer the query's own wording when it already is that standard name.
- Expand a bare acronym; choose the singular/plural form the community writes.
- Do not invent compound "X and Y" catalogue names, do not qualify with
  "Advanced"/"Techniques"/"Applications", and do not narrow or broaden the field to
  fit an existing branch. Exact means: a researcher of this field would name it so.

**2. Choose the parent — the node this field is genuinely housed in.**
- Read the outline around every plausible branch before committing. The new node
  becomes a child of your parent, one level below it; since the taxonomy has
  exactly four levels, the parent must be a domain, field or subfield — never a
  topic. Normally the right parent is a subfield, making the new node a topic.
- **House by discipline, not by flavour.** Place the field where, in a university,
  its research groups actually sit. A method field with mathematical content is not
  thereby mathematics; an application of physics is not thereby physics.
- **Check the siblings.** Under your intended parent, would the new node read as a
  natural peer of the existing children? If it would be the odd one out, the parent
  is probably wrong.
- **Do not stretch.** If no deep node houses the field, attach it higher (a field
  rather than a subfield) instead of forcing it into the least-wrong subfield.

**3. List the other spellings.** Acronyms, the plural or singular you did not choose,
and common variant wordings that should resolve to this same node.

## Output

Return exactly one JSON object and nothing else:

```json
{
  "name": "<canonical field name>",
  "parent": "<name of the existing node to inject under, verbatim from the outline>",
  "aliases": ["<other spellings>"],
  "reason": "<one or two sentences: what the field is and why this parent houses it>"
}
```

## Guards — do not violate

- The parent must be a name that appears in the outline, at domain, field or
  subfield depth. Never a topic.
- Never justify a placement by shared words between names; justify it by where the
  field's research is done.
- Never return a name that merely repackages an existing node — if an existing node
  IS this field, that should have been decided as a match upstream; return that
  node's name as `parent` only if the query is genuinely a subarea one level below it.
