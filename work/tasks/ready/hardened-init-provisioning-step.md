---
title: Init hardening step: engine + resumable provisioning flow + self-re-exec wiring
slug: hardened-init-provisioning-step
prd: hardened-dedicated-account-deployment
blockedBy: [hardened-self-reexec-invocation, hardened-preflight-checks, hardened-tier2-script-generator]
covers: [1, 2, 5, 6, 7, 8]
---

## What to build

The engine that stitches the three pure pieces (self-re-exec invocation, preflight, Tier-2 generator) into anon-pi's `init` flow, plus the THIN impure wiring in `cli.ts`. This is where "actively help, never silent root" becomes a real, resumable onboarding step, and where the always-redirect self-re-exec is hooked into the normal launch path.

Deliver two layers:

- **Pure orchestrator (`src/anon-pi.ts`):** given injected preflight results + install state, decide the next action of the resumable hardening step: if the `anon` account is missing/half-provisioned, produce the Tier-2 script + a "run this with sudo in another terminal, then continue" instruction; if the preflight passes, proceed with Tier 1 (resolve `ANON_PI_HOME` into `anon`'s tree, the `chmod 700` intent) and finish. No wrapper file is produced (self-re-exec replaces it). Never sets `NETCAGE_GRAPHROOT`.
- **Thin impure wiring (`src/cli.ts`):** the `init` prompt "run anon-pi under a dedicated `anon` account?" (TTY-gated exactly like the existing interactive `init`); the real probes feeding the preflight; the real workspace writes (into a temp-isolable location in tests); the resumable loop (print script -> wait/re-check -> continue once the account exists); and hooking the should-redirect predicate into the normal launch entry so that, on a hardened install, a login-user invocation self-re-execs via `sudo -u anon -i anon-pi "$@"` before doing anything else (guarded against the anon self-loop). There is NO `harden` verb and NO `--hardened` flag: hardening is a step INSIDE `init` (which already auto-runs when uninitialised).

Reuse the existing `resolveAnonPiHome` and the existing `runInit` structure. Keep the composition logic pure/injectable; the impure layer stays thin (spawn/prompt/probe/write), matching the repo's style.

## Acceptance criteria

- [ ] `init` asks whether to run under a dedicated `anon` account (TTY-gated like the existing interactive init); there is no `harden` verb and no `--hardened` flag.
- [ ] The hardening step is RESUMABLE: when the account is missing/half-provisioned it prints the Tier-2 script and a "run it, then continue" instruction; on re-run/continue it RE-CHECKS via the preflight and proceeds once the account exists.
- [ ] Tier 1 sets `ANON_PI_HOME` into `anon`'s tree and applies `chmod 700`; NO wrapper file is written; `NETCAGE_GRAPHROOT` is never set.
- [ ] On a hardened install, a login-user invocation self-re-execs via `sudo -u anon -i anon-pi "$@"` (reusing the pure predicate + argv builder), and a caller already running as `anon` does NOT re-exec (no loop).
- [ ] The pure orchestrator decisions are unit-tested over injected preflight results (missing-account -> print-script-and-wait; passing -> continue); the impure wiring is thin.
- [ ] Tests ISOLATE the workspace: point `ANON_PI_HOME` at a temp dir and assert the real `~/.anon-pi` and `~anon` are UNTOUCHED; no test runs real `sudo`/`su`/`podman`/`netcage`/`loginctl` or touches a shared/global location (every OS-touching bit is an injected/stubbed seam).
- [ ] Every change produces a changeset; the `verify` gate passes.

## Blocked by

- `hardened-self-reexec-invocation` — the should-redirect predicate + argv builder this step hooks into the launch path.
- `hardened-preflight-checks` — the preflight predicates the resumable step re-checks against.
- `hardened-tier2-script-generator` — the script this step prints for the human.

## Prompt

> FIRST, check this task against current reality (launch snapshot; may have drifted): confirm the three dependency tasks landed as assumed (a pure should-redirect predicate + argv builder, pure preflight predicates over injected probes, a pure Tier-2 script generator), and that `runInit`/`resolveAnonPiHome` and the pure/impure split still look as this task expects. If any dependency landed differently, do NOT build on the stale premise — route to needs-attention with the discrepancy.

You are wiring the hardened-deployment onboarding into anon-pi (host-side launcher for the netcage jail). Domain (see prd `hardened-dedicated-account-deployment` + `CONTEXT.md`): hardening runs anon-pi's workspace under a dedicated `anon` Unix account so a host agent as your login user cannot casually surface anonymized session transcripts. It is INIT-DRIVEN (no `harden` verb, no `--hardened` flag): anon-pi already auto-runs `init` when uninitialised, and `init` now asks whether to harden. "Actively help, never silent root": Tier 1 (rootless: ANON_PI_HOME into anon's tree, chmod 700, no wrapper file) is done directly; Tier 2 (root: create account etc.) is a GENERATED script the human runs, and `init` is RESUMABLE across it (print script -> user runs it in another terminal -> preflight re-checks -> continue). Day to day, a hardened install self-re-execs every login-user invocation via `sudo -u anon -i anon-pi "$@"` (always-redirect, option A), guarded so a caller already `anon` does not loop. Never set `NETCAGE_GRAPHROOT`; never weaken netcage's forced-egress (the proxy stays on every netcage argv — this feature only changes WHICH user anon-pi runs as).

Goal: land the pure orchestrator (resumable next-action decision over injected preflight results; Tier-1 plan) in `src/anon-pi.ts`, and the thin impure wiring in `src/cli.ts` (the init prompt, real probes, real workspace writes, the resumable loop, and hooking self-re-exec into the launch entry). Reuse `resolveAnonPiHome` and the existing `runInit` shape.

Test the orchestrator at the pure seam (missing-account -> print-and-wait; passing -> continue) and isolate the workspace via a temp `ANON_PI_HOME`, asserting the real homes are untouched and no real sudo/podman/netcage/loginctl runs. "Done" = engine + wiring + tests green under the verify gate, with a changeset committed.

> RECORD non-obvious in-scope decisions (e.g. how "continue after account creation" is signalled non-interactively, the self-loop guard mechanism, idempotency of re-runs) as an ADR if they meet the gate, else a `## Decisions` note in the done record.
