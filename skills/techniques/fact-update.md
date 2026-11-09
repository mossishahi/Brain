---
name: fact-update
kind: technique
description: "Reconsider work that cites a badge the fact table has deleted: read the notices, revise what relied on the deleted fact, and change nothing else."
vars: []
capabilities: []
---
# Reconsidering after a fact update

The supreme judge withdrew one or more badges from the run's fact table because
a later check invalidated their justification or a supporting premise.
Withdrawal need not establish the opposite claim. `factUpdates` holds one notice per deleted
badge: the `deleted` id, the `claim` and `conditions` it stood for, the judge's
`reason`, the `replacement` badge when the ruling issued one, and `citedAt`, the
steps that cite the deleted badge. A deleted badge no longer exists for anyone:
nothing may cite it as support, and `fact_table` answers its id as deleted.

Revoker has assessed the consequences and supplies recoveryPlan for the exact
version you received. Follow that action and repair scope; Supreme does not
approve or override it. Reconsider the identified dependencies, including
implicit consequences that do not contain a badge token:
- When the notice names a replacement, compare its claim and conditions with
  what your sentence needs. Cite it only if it covers that within its
  conditions, and keep the sentence within them.
- Otherwise rebuild the point on other verified support, keep it explicitly
  conditional, or drop it with everything that depends on it.
- A report may describe a withdrawn fact as a historical or rejected premise.
  In newly written text, write its identifier plainly (for example F:3), without
  active citation brackets. Explain that it was withdrawn; do not present it as
  support.

Preserve reasoning outside Revoker's authorized repair scope. Treat factual
claims and supplied evidence as material to check. If the selected action cannot
produce sound reasoning, explain the obstacle instead of silently expanding the
scope or claiming success. Repaired arguments require fresh review before final
use; earlier scores remain historical records.

When recoveryPlan includes reviewFeedback, inspect the previous candidate and
its rejected scientific review. Produce a complete patch against the original
version supplied in this task, resolving the rejection as well as the withdrawn
premise. A new attempt is not permission to repeat the same rejected argument.
