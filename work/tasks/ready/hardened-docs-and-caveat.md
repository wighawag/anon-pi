---
title: Hardened-deployment docs + discoverability-boundary caveat
slug: hardened-docs-and-caveat
prd: hardened-dedicated-account-deployment
blockedBy: [hardened-init-provisioning-step]
covers: [10, 11]
---

## What to build

The user-facing documentation for the hardened deployment, once the flow exists. It must describe the init-driven hardening flow and state the boundary's limits HONESTLY.

Deliver (in the README / docs, matching where anon-pi documents its verbs):

- **The flow:** running `init` on a fresh/uninitialised anon-pi asks whether to run under a dedicated `anon` account; if yes, Tier 1 (rootless setup) happens and Tier 2 (a reviewable root script) is printed for the human to run with sudo; `init` is resumable across that step. Day to day, a hardened install runs anon-pi as `anon` automatically (self-re-exec via sudo, one password prompt within sudo's cache window).
- **The discoverability-boundary caveat, stated LOUDLY:** this defends against an UNPRIVILEGED host process/agent running as your login user. A host agent with root (or blanket passwordless sudo) defeats it entirely (root ignores DAC). If your host agents run with broad sudo, this buys little. The sudo password is a FEATURE: it makes crossing deliberate so a casual "find my old work" never trips into it.
- **Composes with ephemeral runs:** note it stacks with the ephemeral-run idea (nothing kept to find) as belt-and-suspenders.
- **Scope notes:** no wrapper command (anon-pi is its own wrapper); a hardened install always redirects (no non-hardened coexistence on the same box); the standalone `harden` verb + workspace migration are a future follow-up (`harden-command-with-import` idea).

## Acceptance criteria

- [ ] Docs describe the init-driven hardening flow (Tier 1 rootless + Tier 2 reviewable root script + resumable continue + day-to-day self-re-exec).
- [ ] The unprivileged-only caveat is stated plainly (root/blanket-sudo defeats it), and the sudo-password-as-deliberate-crossing rationale is explained.
- [ ] Docs note it composes with the ephemeral-run idea and that migration / a standalone `harden` verb are a documented future follow-up (not in v1).
- [ ] Docs do NOT claim hard containment and do NOT reference a separate `anon` wrapper command or `--hardened` flag (neither exists).
- [ ] Confirm the hardened vocabulary (dedicated `anon` account, hardened deployment / DAC boundary, self-re-exec) is present in `CONTEXT.md` (owned by `hardened-self-reexec-invocation`); if it is missing when this task runs, add it here so the glossary matches the shipped docs.
- [ ] Every change produces a changeset; the `verify` gate passes (`pnpm format:check` covers the docs).

## Blocked by

- `hardened-init-provisioning-step` — the flow must exist and be settled before it is documented (so the docs match real behaviour, not a stale snapshot).

## Prompt

> FIRST, check this task against current reality (launch snapshot; may have drifted): read how the init hardening step actually landed (the dependency task's done record + the code) and document THAT, not this snapshot. If the implemented flow differs from what is described here, document the implemented flow and note the drift.

You are documenting the hardened deployment of anon-pi (host-side launcher for the netcage jail). Domain (see prd `hardened-dedicated-account-deployment` + `CONTEXT.md`): hardening runs anon-pi under a dedicated `anon` Unix account so a host agent as your login user cannot casually surface anonymized session transcripts. It is a DISCOVERABILITY boundary (plain Unix DAC), NOT hard containment: root or blanket sudo defeats it, and the docs must SAY SO loudly so no one over-trusts it. It is init-driven (no `harden` verb, no `--hardened` flag, no wrapper command); a hardened install always self-re-execs as `anon`.

Goal: write the user-facing docs for the flow (init asks -> Tier 1 rootless -> Tier 2 reviewable root script the human runs -> resumable continue -> day-to-day self-re-exec with one sudo prompt), state the unprivileged-only caveat and the sudo-password-as-feature rationale plainly, note it composes with ephemeral runs, and mark the standalone `harden` verb + migration as a future follow-up. Match where anon-pi documents its other verbs. Do NOT claim hard containment; do NOT reference a wrapper command or `--hardened` flag.

"Done" = the docs land, match the implemented flow, and the verify gate is green (format:check included), with a changeset committed.

> RECORD any non-obvious doc decision briefly in the done record if it materially shapes how the boundary is presented.
