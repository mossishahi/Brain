---
name: academic-profile-lookup
kind: technique
description: "A reliable procedure for turning a person's name into their canonical academic profile and their stated research interests, copied verbatim — with identity disambiguation and a clear source priority. Use whenever a step must ground an author in attributable research interests."
vars: []
capabilities: [web-search]
---
# Technique: Academic Profile Lookup

Given a **person's name** plus the **context that surfaced them** (the paper they authored, its
topic, their co-authors, or their affiliation), find *that exact person's* academic profile and
record their **stated research interests verbatim**. Do not guess, and do not confuse them with a
same-named person.

## Procedure
1. **Search by name + a disambiguator** from the context — the paper title, a co-author, the
   affiliation, or the topic (e.g. `"Jane Doe" graph neural networks MIT`). A bare name is not enough.
2. **Resolve the canonical profile** in this source priority (use the first that clearly matches):
   1. **Google Scholar** profile — its **"Research interests"** tags (plus verified email / affiliation).
   2. **ORCID** record — keywords and works.
   3. **OpenAlex** or **Semantic Scholar** author page — `concepts` / `fields of study`.
   4. The author's **institutional / lab faculty page** — stated research areas.
3. **Confirm identity before trusting a profile.** It must match the person via at least one hard
   signal: the **affiliation**, a **shared co-author**, or **the retrieved paper appearing in their
   publication list**. If two people share the name and you cannot tell them apart, choose none.
4. **Extract interests verbatim.** Copy the interest labels exactly as written (e.g.
   `Variational Inference`, `Optimal Transport`). Do not paraphrase, expand, translate, or merge.
5. **If nothing reliable is found**, record `no_profile` for that person — never substitute
   interests from your own knowledge, from the paper's abstract, or from its citations.

## Record (one per queried name, kept as working material)
- `name` — as given
- `profile_url` — the resolved source URL, or empty
- `source` — `google_scholar` | `orcid` | `openalex` | `semantic_scholar` | `faculty_page` | `none`
- `research_interests` — the verbatim list, or `[]`
- `status` — `ok` | `ambiguous` | `no_profile`

## Guards — do not violate
- **Verbatim only** — interests are copied from the resolved profile, never inferred.
- **Right person only** — never attach interests to a name without an identity-confirming signal.
- **No backfill** — `no_profile` / `ambiguous` is a valid, honest result; do not invent interests to avoid it.
