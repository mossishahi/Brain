---
name: literature-review
kind: technique
description: "Establish, for a given research input, what already exists: a trusted literature map, the chronological ordering of the relevant works, their citation graph, and an explicit is-this-already-solved assessment — conducted from the using agent's own scientific vantage (department, field, working areas — filled per agent by the runtime) when one is declared, as an interface review of the literature BETWEEN fields when the vantage is an interdisciplinary seat spanning several fields, or as a general review aimed at the submission's own area when the vantage lines are empty; carried as working material that the caller positions its own contribution against."
vars: [department, umbrella, subfields]
capabilities: [web-search]
---
# Technique: Literature Review

You are executing this technique as part of a larger task: before developing anything, map what
already exists. The result is a structured **literature map** you keep as working material and
consult throughout your task — especially when claiming novelty.

## The vantage — read first
The runtime fills these three lines for the agent executing this technique. They are always
YOUR OWN seat — never another member's, never the thinker's, never the submitter's:

- department: {{department}}
- field: {{umbrella}}
- working areas: {{subfields}}

**When the lines above carry a vantage**, this review is conducted from it, never from nowhere:
you search as a researcher of that field whose working areas are those named. Every real
literature review is written from somewhere — declaring the vantage is what makes the bias honest
and the map deep: an aimed search surfaces the works a generalist sweep never finds, and reads
each one the way a working scientist of those areas would read it. The vantage controls where
you AIM, never what you ADMIT:

- **Aim from inside.** Phrase every query in the vantage's own terms of art — the exact
  vocabulary of the working areas first, the field's broader phrasings second — and direct it at
  the venues, benchmarks, and author communities where these areas publish.
- **Admit what returns.** Record whatever an aimed search honestly surfaces, including a decisive
  work from another field, and read it through the vantage: what it means FOR these areas.
  Never drop a result to keep the map pure — and never widen the aim into a survey of fields that
  are not yours.
- **Judge by the vantage's standards.** Relevance, strength of result, credibility of venue,
  seriousness of baseline: assess them as that field assesses them, and let each work's
  relation line say so.

**When the vantage is an interdisciplinary seat** — its field names the space BETWEEN several
fields rather than one of them (an interdisciplinary department, a field line spanning named
disciplines, working areas that are interfaces) — this review is an INTERFACE review: the
literature you map is the literature between the named fields, not any single field's own.
The same aim/admit discipline applies, sharpened to the seams:

- **Aim at the interfaces.** For each pair of the named fields whose interface plausibly bears
  on the input, derive at least one facet that combines the two vocabularies — the phenomenon as
  one field names it joined with the method or object as the other names it — and direct it at
  the venues, communities, and author groups that publish across those fields. Do not spend
  facets on any single field's interior; its own seat covers that.
- **Admit what returns, from either side.** A decisive single-field work still enters the map —
  read for what it means AT the interface: what it licenses, blocks, or settles for a crossing.
- **Judge by the interface's standards.** Where an interface community exists, assess relevance,
  strength, and venue credibility by its norms; where none exists yet, record a work as settling
  a cross-field point only when it would satisfy BOTH parent fields' standards, and say so in
  its relation line.

**When the lines above are empty**, no vantage is declared and this is a GENERAL review: aim
your queries at the submission's own area — the field the input itself belongs to — phrase them
in that area's standard vocabulary, and judge relevance, strength, and venue credibility by that
area's norms. General means unseated, never shallow: every guard and every procedure step below
applies unchanged.

## Guards — do not violate
- **No invented papers.** Every work you record must come from an actual search result and carry a
  resolvable URL or DOI. If you cannot point to where you found it, it does not go in the map.
- **Trusted sources only.** Peer-reviewed venues, arXiv/bioRxiv/medRxiv preprints, and established
  publishers. No blog posts, news articles, or social media.
- **Run every search yourself, inside this same task.** Do not delegate the review; stay within
  about 15 queries total, using your web-search capability.
- **Verbatim metadata.** Titles, authors, years, and venues exactly as the source states them.

## Procedure
1. **Facets.** From the research input (question, context, assumptions), derive the search facets
   from inside your vantage — or, in a general review, from inside the submission's own area:
   the core phenomenon as that field names it, plus at least one synonym phrasing also in use;
   the method angle and the application angle in the same vocabulary; and, when a vantage is
   declared, one facet per working area that makes the input visible to that area. Add no facet
   whose purpose is coverage of a field outside the review's aim.
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
