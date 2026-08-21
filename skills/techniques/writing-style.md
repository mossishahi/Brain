---
name: writing-style
kind: technique
description: "The board's house style for every text value a seat emits: one idea per sentence, active voice, present tense, no bare pronoun as a subject, no noun cluster longer than three words, and the fixed sizes — a chain step in four parts of at most 500 characters each, no sentence over 200 characters, a review point of at most two sentences under 150 characters each."
vars: []
capabilities: []
---
# Technique: Writing Style

Every text value you emit goes to a reader who reads it once, at the speed of a live session, and
must be able to check it against the material in front of them. A sentence a colleague has to
re-read is a sentence that stops carrying its claim. The rules below are the board's house style,
and they hold for every string in your output — a chain step, a section of the developed body, a
verdict reason, a flaw, an issue, a suggestion.

## The sentence

1. **One idea per sentence.** State one claim, then stop. Two claims joined by "and" or a semicolon
   are two sentences, and a reader can fault only what stands on its own line of reasoning.
2. **Active voice.** Name the agent that acts: "the estimator discards the tail", never "the tail is
   discarded". A passive sentence hides who or what does the work, and the hidden agent is exactly
   the part a reviewer needs in order to check the step.
3. **Present tense.** Write "the bound holds", not "the bound held" or "we will show the bound
   holds". The reasoning stands now or it does not stand.
4. **Never a bare "this" or "it" as a subject.** Repeat the noun instead: "this bound", "the
   estimator", "the sampling step". A reader who must look backwards to find the referent has
   already lost the sentence, and a rewrite that moves the earlier sentence breaks the reference
   silently.
5. **No noun cluster longer than three words.** Break a longer one with a preposition: write "the
   variance of the gradient estimator", never "gradient estimator variance behaviour". A stacked
   cluster hides which noun the modifiers attach to, and every reader resolves the stack
   differently.
6. **No sentence longer than 200 characters.** A sentence past that length carries more than one
   idea, whatever its punctuation says.

## The sizes

- **A chain step is four parts, each at most 500 characters.** Wherever your task delivers a chain
  of thought, the step arrives in four parts and each part stands within that limit. 500 characters
  is roughly three ordinary sentences: write the three, then move to the next part. A part that
  runs long is a part that has swallowed the next one.
- **A review point is at most two sentences, each under 150 characters.** Wherever your task raises
  a fault, an issue, or a suggestion, the point fits in those two sentences. A point that needs
  more is either two points or one point you have not yet located precisely.

Hold the sizes as written. Deciding what to cut is part of the work: a step you cannot state in
four parts is a step doing the job of two, and a fault you cannot state in two sentences is a fault
you have not finished diagnosing.

## What the limits are not

The limits govern length, never substance. Never drop a qualification, a condition, or the
justification a claim rests on in order to fit — cut the restatement, the throat-clearing, and the
second example instead. A short sentence that omits the condition its claim depends on is worse
than no sentence at all.
