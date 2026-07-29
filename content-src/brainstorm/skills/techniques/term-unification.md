---
name: term-unification
kind: technique
description: "A reusable procedure for collapsing a pool of raw expertise terms into one entry per distinct research area: group the surface variants of a single area (case, plural, acronym, empty qualifier), merge them under one canonical name, and sum their support as a count of distinct people — never merging a broader area with a narrower one."
vars: []
capabilities: []
---
# Technique: Term Unification

You hold a **pool** of expertise terms collected verbatim from many people, each term carrying how
often it was listed and by whom. One research area almost always arrives under several surface
forms, so a raw pool over-counts how many distinct areas there are and under-counts the real
support behind each one. This technique produces exactly one entry per distinct area, with a count
that reflects how many people actually work in it.

Unify before anything else touches the pool. Any ordering, ranking, or level assignment applied to
an unmerged pool is computed on the wrong counts.

## Procedure

**1. Comparison keys.** For each term derive a comparison key: lowercase it, drop punctuation and
connecting words, reduce plurals to singular. Keep every original string — the key exists only to
find candidates and never replaces the term itself.

**2. Propose candidate groups.** Group terms that might name one area:
- identical comparison keys — `Variational Inference`, `variational inference`,
  `Variational inference`;
- an acronym and its expansion — `GNN`, `GNNs`, `Graph Neural Networks`;
- one term that is another plus a qualifier word — `Advanced Graph Neural Networks` next to
  `Graph Neural Networks`;
- the same words reordered or joined differently — `Inference in Graphical Models` next to
  `Graphical Model Inference`.

A candidate group is a **proposal only**. Nothing merges until Step 3 admits it.

**3. The same-referent test — run it on every group before merging.** Two terms name one area only
if they denote the **same body of work**. State this sentence to yourself before merging:

> A researcher who lists A would recognise B as another name for exactly what they do — not a
> broader area they sit inside, and not one specialization within it.

If that sentence is false, the group does not merge, however similar the strings look. Break the
group up and keep the terms separate.

**4. Canonical name.** For each admitted group choose one name:
- prefer the expanded form over the acronym;
- prefer the form the area is conventionally named in;
- among otherwise equal options prefer the variant the most people used.

The canonical name must be one of the collected variants, or the standard expansion of a collected
acronym. Never mint a name nobody used.

**5. Count.** An entry's count is the number of **distinct people** who listed any variant in its
group. Someone who listed two variants counts once, not twice: the count measures how many people
work in the area, not how many strings were collected.

**6. Leave the remainder alone.** A term that joined no admitted group survives unchanged with its
own count. An unmerged pool is a valid outcome.

## Never merge these

Each of these looks mergeable by string similarity and is not:

- **A broader area with a narrower one.** `Machine Learning` is not `Deep Learning`.
  `Graph Neural Networks` is not `Graph Convolutional Networks`. `Bayesian Inference` is not
  `Variational Inference`. Merging here destroys the level distinction a later step depends on, and
  credits the broader term with support it does not have.
- **A qualifier that changes the referent.** `Advanced`, `Modern`, `Novel`, and `Recent` add
  nothing — but `Applied Mathematics` is not `Mathematics`, `Computational Biology` is not
  `Biology`, and `Bayesian Statistics` is not `Statistics`. Judge every qualifier on whether it
  names a different body of work; never work from a list of ignorable words.
- **Two sibling specializations of one parent.** `Variational Inference` and
  `Markov Chain Monte Carlo` are both approximate inference and are not each other.
- **A method and a domain it is applied to.** `Deep Learning` is not `Medical Imaging`.
- **Two areas that merely travel together.** People listing both proves the areas are related,
  never that they are the same.

## Record (kept as working material)

One entry per distinct area: the canonical `term`, its `count` of distinct people, and the
`variants` it absorbed. Carry this through the rest of your task — the variant list is what lets
someone reading the collected interests check a merge.

## Guards — do not violate

- **Merge only.** Never split an area that arrived as a single term, never drop a term, never
  introduce one.
- **Never merge to shorten the pool.** The right number of entries is however many distinct areas
  people actually named, even when that is nearly all of them.
- **Count is the only quantity.** Never re-weight an entry by how prominent, recent, or important
  the area seems. Those judgements belong to later steps, not to this one.
- **Order stably.** Report entries by descending count, breaking ties by the order in which the
  terms first appeared in the pool, so one pool always yields one ordering.
