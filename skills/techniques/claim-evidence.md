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

For independently asserted substantive claims, consult the supreme judge through
`fact_table`: ask about existing support or submit the claim with its conditions
and evidence for independent verification. The tool is a conversation channel,
not direct table access. Only supreme-judge tasks receive the underlying scoped
entries; other agents receive the judge's answers. Cite the resulting `[F:n]` badge
beside the supported claim, respecting its current standing and scope. The
supreme judge checks the proof, computation, or source itself; its consultation
and verification tasks never recursively chat with themselves. The host alone
stores facts and issues badges and approval receipts. A role restricted to
consulting about existing claims carries supported claims forward and identifies
unresolved ones rather than inventing a badge or a new established fact. The judge
compares meaning and applicable conditions, not spelling. Its `badgeHash` identifies
the issued record and evidence revision; a matching hash is not itself evidence
of truth or semantic equivalence. Ask the judge to explain what the badge
establishes and why it applies when that is uncertain.

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
