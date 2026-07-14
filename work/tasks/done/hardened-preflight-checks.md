---
title: Hardened preflight checks + netcage >= 0.11.0 assertion (pure predicates + probe seam)
slug: hardened-preflight-checks
spec: hardened-dedicated-account-deployment
blockedBy: []
covers: [6, 8, 10]
---

> Netcage version floor CONFIRMED = **0.11.0**. The uid-scoped-store fix (netcage ADR-0017) shipped in netcage `v0.11.0`: the commit `965c991` ("uid-scope the store default to fix multi-user collision") is the tip tagged `v0.11.0`; `v0.10.0` still carries the old fixed `/var/tmp/netcage-storage` (verified in the installed `0.10.0` binary). So `>= 0.11.0` is correct and verified. Keep the floor as a single NAMED constant (one line to bump), but the number itself is settled: `0.11.0`.

## What to build

The PURE preflight that CHECKS a dedicated-account deployment is set up correctly and prints exactly what is missing, so a half-provisioned `anon` account fails loudly with remediation rather than cryptically.

Deliver in the pure module (`src/anon-pi.ts`) a set of pure predicates, each over an INJECTED probe result (the real probe is the impure seam, stubbed in tests):

- **subuid/subgid ranges present** for `anon` (rootless podman needs them).
- **linger on** for `anon` (`loginctl enable-linger` — so `$XDG_RUNTIME_DIR` exists without an active login session).
- **`/dev/net/tun` accessible** (netcage needs it).
- **account `$XDG_RUNTIME_DIR` present** for `anon` (podman runroot lands there).
- **netcage version >= 0.11.0** (netcage ADR-0017, CONFIRMED floor). Parse the version string, compare against the floor, and treat netcage ABSENT or an UNPARSEABLE version as a fail-loud failure (not a silent pass). Express the floor as ONE named constant (do NOT scatter the literal `0.11.0`), so a future bump is a one-line change.

Each failing check yields its EXACT remediation message (what is missing + how to fix it). Compose them into a single preflight result (all-pass, or the list of failures with their messages). This is a pure evaluator over injected probe inputs — mirror the repo's injected-`exists`-style seam; the real probes (reading `/etc/subuid`, `loginctl show-user`, `stat /dev/net/tun`, `netcage --version`, etc.) belong in `cli.ts`'s impure layer and are wired by the init-provisioning task, not here.

## Acceptance criteria

- [ ] The netcage version FLOOR (`0.11.0`, confirmed) is a single named constant, not a scattered literal.
- [ ] Each check is a pure predicate over an injected probe result; none reads the real filesystem / runs a real command inside the pure function.
- [ ] The netcage-version check passes on `>= 0.11.0`, FAILS on `< 0.11.0` (e.g. `0.10.0`), and FAILS LOUD (with a distinct remediation) when netcage is absent or the version is unparseable.
- [ ] Each failing check produces its exact remediation string; the composed preflight result reports all-pass or the ordered list of failures.
- [ ] The preflight does NOT set or reference `NETCAGE_GRAPHROOT` (the uid-scoped default handles the store; setting the knob is explicitly out of scope).
- [ ] Tests cover each check's pass and fail branch and the exact remediation text, plus netcage absent/unparseable (mirror the repo's pure-module test style).
- [ ] No test runs a real `netcage`/`loginctl`/`stat` or reads a real system path; every probe result is injected.
- [ ] Every change produces a changeset; the `verify` gate passes.

## Blocked by

- None — can start immediately.

## Prompt

> FIRST, check this task against current reality (launch snapshot; may have drifted): confirm the pure/impure split (`src/anon-pi.ts` pure, `src/cli.ts` spawn) and the injected-probe idiom still hold, and check whether a netcage-version probe already exists in `cli.ts` to reuse the parse. If the split changed or a version helper already lives somewhere, build on it; else route drift to needs-attention. The netcage version floor is CONFIRMED = `0.11.0` (the uid-scoped store shipped in netcage `v0.11.0`, ADR-0017); keep it as a named constant.

You are adding the hardened-deployment PREFLIGHT to anon-pi (host-side launcher for the netcage jail). Domain (see spec `hardened-dedicated-account-deployment` + `CONTEXT.md`): the hardened deployment runs anon-pi's workspace under a dedicated `anon` Unix account so a host agent as your login user cannot casually surface your anonymized session transcripts. A half-provisioned account must fail LOUDLY with remediation. The netcage dependency is the UID-SCOPED store (each Unix user gets `/var/tmp/netcage-storage-<uid>` automatically), shipped in netcage `v0.11.0` (ADR-0017) — anon-pi does NOT set `NETCAGE_GRAPHROOT`, it just runs netcage as `anon` and the store scopes itself. The preflight only ASSERTS netcage is new enough.

Goal: land the PURE preflight predicates in `src/anon-pi.ts` — subuid/subgid present, linger on, `/dev/net/tun` accessible, account `$XDG_RUNTIME_DIR` present, netcage >= 0.11.0 (with absent/unparseable = fail-loud) — each over an INJECTED probe result, each emitting an exact remediation string, composed into one all-pass-or-list-of-failures result. Express the version floor (`0.11.0`, confirmed) as ONE named constant, never a scattered literal. Keep the real probes in the impure layer (wired later by the init-provisioning task); here everything OS-touching is an injected seam. Do NOT weaken netcage's forced-egress invariant and do NOT introduce a `NETCAGE_GRAPHROOT` knob.

Test at the pure-predicate seam: each check's pass/fail branch, exact remediation text, and the netcage absent/unparseable branches. "Done" = pure preflight + tests green under the verify gate, with a changeset committed.

> RECORD non-obvious in-scope decisions (e.g. the exact version-parse/compare rule, or what counts as "unparseable") as an ADR if they meet the gate, else a `## Decisions` note in the done record.
