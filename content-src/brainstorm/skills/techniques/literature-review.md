---
name: literature-review
kind: technique
description: "Produce an agent-owned, structured literature-review deliverable: inspect relevant sources, explain each work's relationship to the original submission, and assess what the inspected evidence resolves or leaves open. Persist the review through literature_review before relying on it in a completed result."
vars: []
deliverables: [literatureReviewV1]
capabilities: [web-search]
---
# Technique: Literature Review

Every invocation produces a saved, reviewable `literatureReviewV1` deliverable through
`literature_review`. It is part of your output, not private working material and not merely a
bibliography. The host attaches your submitted reviews to your result. Do not duplicate their
full JSON inside a role's final result or add fields that its result schema does not accept.

## Scope and ownership

Begin from the ORIGINAL user submission and its requested outputs, not just the latest critique,
a rewritten research question, or your preferred method. The tool supplies the original input
requirements with stable IDs and text; copy that list exactly into `scope.inputRequirements`.
State this review's particular question and your own scientific vantage in `scope`. Use the
expertise declared by your role; an interdisciplinary seat examines interfaces between its
fields. An unseated role states its task-specific vantage. Never impersonate another seat.

Aim searches using that vantage's vocabulary and standards, but admit relevant evidence from
any field. Connect each included work to the original input, including why an initially promising
work does not apply. A targeted source check can contain one work. A broader landscape or novelty
review needs enough evidence to support its scope; there is no mandatory paper count or search
quota. A single fact check does not require an unrelated full survey.

Each review and every interpretation belongs to its author. The host may cache source bytes and
metadata, but it does not merge agents' assessments into a shared bibliography or treat one
agent's review as another's independent reading. A review is not a fact badge. Substantive claims
still follow the shared claim-evidence policy, with Supreme as the sole fact authority. Supreme
must independently inspect evidence when verifying a claim and must not recursively call itself.

## Read evidence before interpreting it

1. Derive search facets from the input and your expertise. Record actual queries and sources;
   never claim a search was performed when it was not. Follow relevant older foundational works
   as well as recent results. Stop when additional searches no longer change the assessment, or
   record why coverage remains incomplete.
2. Resolve each paper's identity from an actual retrieved source. Preserve its exact title and
   known authors, year, venue, URL/DOI and inspected version; use null for unknown metadata.
   Never invent a citation, version, retrieval receipt, or page number.
3. Use `paper_read` to open accessible full text, then read/search the sections needed to assess
   the method, results and assumptions. Use page images when equations, tables, figures or text
   extraction require visual inspection. Reading an abstract is not reading a proof or method.
4. Record the host-issued document, receipt and segment IDs plus their page/section locator in
   `inspected.evidence`. An open/metadata response alone does not establish passage inspection.
   Set `inspected.level` to the scope actually inspected. Relevant sections are often sufficient;
   do not claim `full-text` unless the full text was actually delivered and inspected. Identify
   the retrieved source revision/hash in `source.version` for section/full-text assessments.
5. If access is blocked or extraction is incomplete, try an accessible official version,
   repository copy or user-provided source where appropriate. Record version differences.
   Metadata-only or abstract-only records must disclose this in `accessLimitations`; do not
   extrapolate uninspected assumptions, proofs, experiments or conclusions. Missing access is
   uncertainty, never evidence that no relevant work exists.

## Required draft for every review

Call `literature_review` to begin the scoped review if it is not already open. Save progress
incrementally; a saved draft is not a completed review. Use the supplied schema rather than
inventing a final-output field. Every work in `works` contains:

- `source`: exact identity and inspected version.
- `inspected`: the access level, delivered evidence references and access limitations.
- `method` and `results`: what the inspected source actually establishes; explicitly state what
  is unknown when the available material cannot establish the method or result.
- `conditions` and `limitations`: assumptions, domain and material qualifications. An empty list
  means no item was identified in the inspected material, never proof that none exists.
- `relevance`: at least one original requirement ID, a relationship (`solves`,
  `partially-addresses`, `supports`, `contradicts`, `background` or `not-applicable`), and a
  concrete justification. Explain how the source's objects, assumptions, result and limitations
  connect to what the user asked. Shared words or a matching title are not a justification.
- `intendedUse`: for example baseline, supporting evidence, counterexample or context, with the
  intended comparison stated explicitly. `uncertainties` records unresolved reading or evidence.

Complete `search` with executed queries, coverage and limitations. Complete `synthesis` with
closest collected work IDs, findings, comparisons and remaining gaps. Make chronological lineage
visible when supported; record citation relationships only when inspected evidence establishes
them. Distinguish an author-stated limitation from your inference. Compare compatible conditions;
do not declare your treatment novel merely because its vocabulary or application differs.

The solved/open assessment is relative to the reviewed evidence and original input. An existing
solution is a valid finding. A lack of retrieved evidence supports `undetermined`, not a claim of
novelty. No relevant works is a valid explicit result after an honest search. Inaccessible sources
or unresolved decisive questions produce `incomplete`, with the missing evidence in `statusReason`.

Submit the completed structured review through `literature_review`. Validation checks structure
and evidence provenance, not scientific truth. Fix the reported defect in the saved draft without
restarting the research or fabricating a value to satisfy the schema. Every actual invocation
must end with a submitted review, including an honest incomplete or no-relevant-works record.

Before developing a completed contribution, submit the review that establishes its closest
existing approaches and comparison. You may explore provisional ideas while evidence is missing,
but do not use unsupported source interpretations to establish a final claim. Later reading that
changes the assessment creates your own revised review; do not silently reuse outdated conclusions.
