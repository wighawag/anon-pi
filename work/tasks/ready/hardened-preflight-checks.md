---
title: Hardened preflight checks + netcage uid-scoped-store floor assertion (pure predicates + probe seam)
slug: hardened-preflight-checks
prd: hardened-dedicated-account-deployment
needsAnswers: true
blockedBy: []
covers: [6, 8, 10]
---

<!-- open-questions -->

## Open questions

1. **What is the exact netcage version floor to assert?** The uid-scoped-store fix (netcage ADR-0017, accepted) is what this preflight checks netcage is new enough to have. The PRD originally wrote `>= 0.11.0`, but that number is UNCONFIRMED against a shipped release: at tasking time netcage's latest git tag was `v0.9.0`, the installed binary reported `0.10.0`, ADR-0017's code was merged on `HEAD` after `v0.9.0`, and no `0.11.0` release existed. So the floor MUST be confirmed against the actual netcage RELEASE that first ships ADR-0017 (`internal/jail/graphroot.go`'s uid-scoped `defaultGraphRoot`) before it is hard-coded. Resolve this number, then clear `needsAnswers`. Until then, keep the floor as a single NAMED constant so only one line changes when the real number is known. Do NOT hard-code `0.11.0` as if it were verified.

<!-- /open-questions -->

## What to build

The PURE preflight that CHECKS a dedicated-account deployment is set up correctly and prints exactly what is missing, so a half-provisioned `anon` account fails loudly with remediation rather than cryptically.

Deliver in the pure module (`src/anon-pi.ts`) a set of pure predicates, each over an INJECTED probe result (the real probe is the impure seam, stubbed in tests):

- **subuid/subgid ranges present** for `anon` (rootless podman needs them).
- **linger on** for `anon` (`loginctl enable-linger` — so `$XDG_RUNTIME_DIR` exists without an active login session).
- **`/dev/net/tun` accessible** (netcage needs it).
- **account `$XDG_RUNTIME_DIR` present** for `anon` (podman runroot lands there).
- **netcage version >= the uid-scoped-store floor** (netcage ADR-0017). Parse the version string, compare against the floor, and treat netcage ABSENT or an UNPARSEABLE version as a fail-loud failure (not a silent pass). The FLOOR ITSELF is an open question (see above): express it as ONE named constant (do NOT scatter the literal), so confirming the real release number is a one-line change. Do NOT bake `0.11.0` in as verified.

Each failing check yields its EXACT remediation message (what is missing + how to fix it). Compose them into a single preflight result (all-pass, or the list of failures with their messages). This is a pure evaluator over injected probe inputs — mirror the repo's injected-`exists`-style seam; the real probes (reading `/etc/subuid`, `loginctl show-user`, `stat /dev/net/tun`, `netcage --version`, etc.) belong in `cli.ts`'s impure layer and are wired by the init-provisioning task, not here.

## Acceptance criteria

- [ ] The netcage version FLOOR is a single named constant, and the open question above (the confirmed release number) is resolved / `needsAnswers` cleared before this task is built. The literal `0.11.0` is NOT hard-coded as verified.
- [ ] Each check is a pure predicate over an injected probe result; none reads the real filesystem / runs a real command inside the pure function.
- [ ] The netcage-version check passes on `>= floor`, FAILS on `< floor`, and FAILS LOUD (with a distinct remediation) when netcage is absent or the version is unparseable.
- [ ] Each failing check produces its exact remediation string; the composed preflight result reports all-pass or the ordered list of failures.
- [ ] The preflight does NOT set or reference `NETCAGE_GRAPHROOT` (the uid-scoped default handles the store; setting the knob is explicitly out of scope).
- [ ] Tests cover each check's pass and fail branch and the exact remediation text, plus netcage absent/unparseable (mirror the repo's pure-module test style).
- [ ] No test runs a real `netcage`/`loginctl`/`stat` or reads a real system path; every probe result is injected.
- [ ] Every change produces a changeset; the `verify` gate passes.

## Blocked by

- None — can start immediately (once the open question is answered).

## Prompt

> FIRST, check this task against current reality (launch snapshot; may have drifted): confirm the pure/impure split (`src/anon-pi.ts` pure, `src/cli.ts` spawn) and the injected-probe idiom still hold, and check whether a netcage-version probe already exists in `cli.ts` to reuse the parse. If the split changed or a version helper already lives somewhere, build on it; else route drift to needs-attention. ALSO: this task carries an open question (the exact netcage version floor) — do NOT build until it is answered and `needsAnswers` is cleared; the floor must be the CONFIRMED netcage release that ships ADR-0017's uid-scoped store, not the unverified `0.11.0`.

You are adding the hardened-deployment PREFLIGHT to anon-pi (host-side launcher for the netcage jail). Domain (see prd `hardened-dedicated-account-deployment` + `CONTEXT.md`): the hardened deployment runs anon-pi's workspace under a dedicated `anon` Unix account so a host agent as your login user cannot casually surface your anonymized session transcripts. A half-provisioned account must fail LOUDLY with remediation. The netcage dependency is the UID-SCOPED store (each Unix user gets `/var/tmp/netcage-storage-<uid>` automatically), shipped in the netcage release that carries ADR-0017 — anon-pi does NOT set `NETCAGE_GRAPHROOT`, it just runs netcage as `anon` and the store scopes itself. The preflight only ASSERTS netcage is new enough.

Goal: land the PURE preflight predicates in `src/anon-pi.ts` — subuid/subgid present, linger on, `/dev/net/tun` accessible, account `$XDG_RUNTIME_DIR` present, netcage >= the uid-scoped-store floor (with absent/unparseable = fail-loud) — each over an INJECTED probe result, each emitting an exact remediation string, composed into one all-pass-or-list-of-failures result. Express the version floor as ONE named constant (the exact release number is the resolved open question), never a scattered literal. Keep the real probes in the impure layer (wired later by the init-provisioning task); here everything OS-touching is an injected seam. Do NOT weaken netcage's forced-egress invariant and do NOT introduce a `NETCAGE_GRAPHROOT` knob.

Test at the pure-predicate seam: each check's pass/fail branch, exact remediation text, and the netcage absent/unparseable branches. "Done" = pure preflight + tests green under the verify gate, with a changeset committed.

> RECORD non-obvious in-scope decisions (e.g. the exact version-parse/compare rule, or what counts as "unparseable") as an ADR if they meet the gate, else a `## Decisions` note in the done record.
