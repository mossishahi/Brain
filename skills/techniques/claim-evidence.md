---
name: claim-evidence
kind: technique
description: "Apply evidence requirements to substantive independent claims, while retaining directly inspectable reasoning without a badge quota."
vars: []
capabilities: []
---
# Claim-level evidence

Evidence follows the claims the reasoning depends on, not its sentence count.
An independently asserted substantive claim needs justified support under the
conditions in which it is used. This includes nontrivial mathematical results,
empirical findings, claims about code or a record, scientific mechanisms,
borrowed results, and consequential generalizations. Identify the actual claim,
its conditions, and its explicit or implicit premises before treating it as
established. A badge for one claim does not justify other unsupported assertions.

Original evidence and published evidence are both valid routes. A complete
proof or derivation, reproducible calculation, experiment, inspected code, or
verified source can support a claim when it actually establishes that claim
under the stated conditions. Original work does not need an external citation
merely because it is new. A source's existence or prestige does not establish
that it supports the claim, and labelling a calculation a proof does not make
its premises or reasoning correct.

For independently asserted substantive claims, begin with fact_table mode=lookup
and only the claim text. No justification is required for discovery. Follow your role's permissions: these
actions describe the channel, not permission to introduce new facts outside your assignment. All roles
consult one shared accepted table through Supreme. The answer supplies an open
conversationId, conceptual matches, conditions, and verified evidence. Continue
with mode=reply and that conversationId:
- action=badge requests the selected existing fact (factId and badgeHash), adopting
  its actual proposition and conditions rather than certifying your original claim.
- action=justify supplies the structured claim, conditions, evidence and kind for
  a new or distinct fact. An original proof or reproducible computation is valid.
- action=challenge also identifies the contrary fact and revision and explains
  exactly why its justification fails and why your proposed fact holds.
- action=clarify supplies message to explain a missing condition or substantive distinction.
- action=close ends the discussion and deletes its saved dialogue state. You may
  start another later; a closed conversation is not retained as history.
Do not submit evidence in the initial lookup or bypass discovery with direct
submit. Never treat closing as acceptance or scientific rejection.

Fact identity includes both proposition and conditions. Semantically equivalent
conditions can reuse a record; genuinely different conditions need a new record.
Supreme may verify a new scoped record by a sound implication from accepted facts,
recording those dependencies instead of unnecessarily repeating an experiment.
Only justified facts enter the table. The host records Supreme's verdict and
issues badges after durable acceptance; no private-to-shared reconciliation exists.
Cite the resulting [F:n] beside the assertion within its verified conditions.
A badgeHash identifies the exact record; it does not establish applicability.
When an old fact is withdrawn, Revoker determines the required reasoning repair
and the host arranges renewed review. Carry out its plan and never silently swap
badges without checking the replacement supports the actual inference.

Ordinary connective text, stipulated definitions, explicit conditional reasoning,
and directly inspectable inferences from stated supported premises do not each
need a separate badge. Show enough reasoning for another scientist to inspect
the inference. For example, deriving a contradiction from two displayed
statements or substituting a stated value into an elementary expression may be
checked directly. A definition fixes how a term is used; it does not establish
an empirical property of what the term names. A conditional conclusion remains
conditional; it does not establish that its assumed premise holds in the task.

There is no blanket exemption for "common knowledge", "a derivation", or "an
assumption". Those labels cannot hide an independently asserted substantive
result, an unsupported empirical premise, or a nontrivial theorem. Verify such
claims with appropriate evidence, even when they appear inside otherwise simple
reasoning. An unverified claim cannot become established just by being called
an assumption; explain the conditional scope and unresolved verification rather
than drawing an unconditional conclusion from it.

Reviewers and the chair decide which claims need independent verification,
including implicit premises, and whether the shown reasoning is sufficient.
Neither a badge count nor the presence of any badge settles that assessment.
A report based entirely on supported directly inspectable reasoning can be
admissible without a badge; the admission reason explains why separate claim
verification was unnecessary. Unsupported substantive claims still prevent
admission even when another part of the report has a valid badge. Never add a
dummy claim or reference to satisfy an imagined minimum number of badges.
