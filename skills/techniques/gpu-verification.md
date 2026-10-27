---
name: gpu-verification
kind: technique
description: "Verify a specific computational claim with a bounded GPU experiment through an approved deployment profile, while distinguishing scientific results from scheduler and environment failures."
vars: []
capabilities: []
---
# Technique: GPU Verification

Use `gpu_run` only when a claim within your assigned task needs accelerator hardware. Prefer a
derivation, existing verified evidence or a short CPU check when it answers the same question.
GPU access is optional: its absence does not prevent work that needs no GPU.

1. **Define one check.** State the claim, the inputs and the observation that would support or
   refute it before submitting. Use one experiment per claim, at the smallest useful scale.
   Reuse a recorded result when its inputs and conditions already cover the claim.
2. **Use the approved profile.** Submit only a self-contained bash script body through
   `gpu_run`. The deployment owner reviews the profile and approves its GPU probe before use.
   The profile supplies the partition, account, QOS, GPU allocation, environment and limits.
   Do not add scheduler directives, submit nested jobs or change that setup. Install packages
   only when the approved profile explicitly supports installation. Do not bypass an unavailable
   GPU tool through another execution tool. The profile's setup prepares the computation;
   your script must not assume that files from another agent's job are present.
3. **Bound the work.** Make at most two GPU submissions in this task, including corrections,
   unless the user explicitly requests more. This instruction is a task budget, not a promise
   that the runtime enforces a submission counter; stricter host limits always apply. Use the
   shortest adequate time limit. Never start a parameter sweep or a large training run merely
   to investigate a suspicion.
4. **Return checkable evidence.** Print the relevant inputs, method, random seed when used,
   device, numeric result and the test criterion. Cite the actual returned result and job
   identifier when the output format permits. Report log truncation or incomplete output;
   a file name alone is not evidence of its contents. A successful probe verifies the host
   setup, not your scientific result.
5. **Classify failure before retrying.** A queue delay, rejected allocation, missing dependency,
   lost scheduler connection or failed environment setup leaves the claim unverified. Report
   that limitation without treating it as an objection to the claim or retrying blindly.
   If diagnostics show an error in your computation, correct it once within the task budget.
   The host never fixes or retries your script for you. If no verified result is available,
   distinguish the proposed experiment from evidence that was actually obtained.
