---
name: literature-review
kind: technique
description: "Establish, for a given research input, what already exists: a trusted cross-field literature map, the chronological ordering of the relevant works, their citation graph, and an explicit is-this-already-solved assessment — carried as working material that the caller positions its own contribution against."
vars: []
capabilities: [web-search]
---
# Technique: Literature Review

You are executing this technique as part of a larger task: before developing anything, map what
already exists. The result is a structured **literature map** you keep as working material and
consult throughout your task — especially when claiming novelty.

## Guards — do not violate
- **No invented papers.** Every work you record must come from an actual search result and carry a
  resolvable URL or DOI. If you cannot point to where you found it, it does not go in the map.
- **Trusted sources only.** Peer-reviewed venues, arXiv/bioRxiv/medRxiv preprints, and established
  publishers. No blog posts, news articles, or social media.
- **Run every search yourself, inside this same task.** Do not delegate the review; stay within
  about 15 queries total, using your web-search capability.
- **Verbatim metadata.** Titles, authors, years, and venues exactly as the source states them.

## Procedure
1. **Facets.** From the research input (question, context, assumptions), derive search facets:
   the core phenomenon (its own wording AND at least one synonym phrasing); the method angle and
   the application angle, phrased separately; your own expertise angle — how YOUR field would name
   this problem; and at least TWO phrasings from fields outside your own (how would a statistician,
   physicist, biologist, or engineer describe the same thing?). Cross-field coverage is a hard
   requirement: related work often lives under a different vocabulary.
2. **Search to saturation.** Query scholarly indexes across the facets, prioritizing the last
   10-15 years but following older foundational works when newer ones point to them. Keep searching
   until two consecutive queries surface no new relevant work, or you reach the ~15-query cap.
   Collect the relevant works — typically 10-20; fewer only if the area is genuinely sparse (note
   that in your assessment).
3. **Record each work** with: a short id slug, title, authors, year, venue, URL, a one-line
   relation (what this work does relative to the topic), and an honest judgement of how much of the
   input it already covers: `no`, `partially`, or `substantially`.
4. **Timeline.** Order the collected works chronologically and make lineage visible where you know
   it ("extends X", "first to do Y").
5. **Citation graph.** Note which collected works cite which (only edges between collected works),
   and identify the root(s) — foundational, most cited within the set — and the frontier — recent
   works nothing in the set cites.
6. **Solved-or-open assessment.** Answer explicitly, judged against the collected works only:
   - status: `open`, `partially solved`, or `solved`;
   - the 2-3 works closest to the input;
   - the open gap: precisely what remains that none of the collected works does. If the status is
     `solved`, state which work solves it — you must know this before developing anything.

Carry this map through the rest of your task: everything you develop must be positioned against
it, and any novelty statement you produce must name the closest works from this map.
