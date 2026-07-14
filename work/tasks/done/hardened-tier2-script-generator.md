---
title: Hardened Tier-2 root provisioning-script generator (pure)
slug: hardened-tier2-script-generator
spec: hardened-dedicated-account-deployment
blockedBy: []
covers: [4, 5]
---

## What to build

The PURE generator for the Tier-2 root-requiring provisioning script that anon-pi PRINTS (but never executes) so the human reviews and runs it with sudo. This is the "actively help, never silent root" boundary: anon-pi emits an auditable script; a person runs it.

Deliver in the pure module (`src/anon-pi.ts`) a pure function that, given the account name (`anon`) and the login user, returns the script TEXT containing:

- `useradd anon` (create the dedicated account, with a home dir).
- `/etc/subuid` + `/etc/subgid` range lines for `anon` (rootless podman subordinate id ranges).
- `loginctl enable-linger anon` (so `$XDG_RUNTIME_DIR` exists without an interactive login).
- The SCOPED sudoers snippet, narrow by design: `<login-user> ALL=(anon) <anon-pi-binary>` — the login user may run ONLY the anon-pi binary as `anon`. Password KEPT (NO `NOPASSWD`) by default; the password is the deliberate-crossing feature.

The script is a reviewable artifact: it should be safe to read top-to-bottom, idempotent where reasonable (e.g. not duplicate subuid lines if re-run), and never do anything beyond the four provisioning steps. Do NOT emit any cross-user `chown`/workspace-migration line: v1 has no existing-workspace migration (that belongs to the deferred `harden` verb). Do NOT emit a `NETCAGE_GRAPHROOT` export.

Keep it a pure string generator (assert the text); the script is NEVER executed by anon-pi and NEVER executed in tests.

## Acceptance criteria

- [ ] A pure generator returns script text containing `useradd anon`, the subuid+subgid lines, `loginctl enable-linger anon`, and the scoped sudoers snippet `<login-user> ALL=(anon) <anon-pi-binary>` for the injected account name + login user + binary path.
- [ ] The default script keeps the sudo PASSWORD (no `NOPASSWD` token present); an opt-in `--nopasswd` path (if included) is OFF by default.
- [ ] The script contains NO cross-user `chown`/migration line and NO `NETCAGE_GRAPHROOT` export.
- [ ] The generator is pure (account name, login user, binary path injected) and the script is never executed by anon-pi or by the tests.
- [ ] Tests assert the presence and shape of each required line, the password-kept default, and the absence of the migration/graphroot lines (mirror the repo's pure-module test style).
- [ ] Every change produces a changeset; the `verify` gate passes.

## Blocked by

- None — can start immediately.

## Prompt

> FIRST, check this task against current reality (launch snapshot; may have drifted): confirm the pure/impure split still holds and that no earlier task already introduced a script-generation helper to extend. If drift, route to needs-attention.

You are adding the Tier-2 provisioning-script generator to anon-pi (host-side launcher for the netcage jail). Domain (see spec `hardened-dedicated-account-deployment` + `CONTEXT.md`): the hardened deployment runs anon-pi under a dedicated `anon` Unix account. Creating that account needs ROOT, and anon-pi (a rootless npm launcher) must NEVER silently sudo. So anon-pi GENERATES a reviewable script for the root parts and the human runs it. The password is kept by default because it is what makes crossing the boundary a deliberate act.

Goal: land a PURE generator in `src/anon-pi.ts` that emits the script text: `useradd anon`, the `/etc/subuid` + `/etc/subgid` lines, `loginctl enable-linger anon`, and the narrow sudoers snippet `<login-user> ALL=(anon) <anon-pi-binary>` (password kept, no NOPASSWD by default). It must NOT emit any cross-user `chown`/workspace-migration line (v1 has no migration — that is the deferred `harden` verb's job) and must NOT emit a `NETCAGE_GRAPHROOT` export (the uid-scoped store handles itself). The script is printed for human review and is NEVER executed by anon-pi.

Test at the pure-generator seam: assert each required line, the password-kept default, and the absence of migration/graphroot lines. The script is never run in tests. "Done" = pure generator + tests green under the verify gate, with a changeset committed.

> RECORD non-obvious in-scope decisions (e.g. exact subuid range choice, idempotency approach) as an ADR if they meet the gate, else a `## Decisions` note in the done record.
