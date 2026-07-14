---
title: `--as <name>` launch selection wiring + preflight for the selected persona (impure)
slug: persona-as-launch-selection-wiring
spec: multi-persona-hardened-accounts
blockedBy: [persona-add-verb-wiring]
covers: [2, 6, 8, 9]
---

## What to build

The day-to-day launch wiring: on a hardened install, `anon-pi --as <name> …` runs as persona `anon-<name>` (default `anon`), re-execing into that account and launching with THAT persona's proxy. Thin impure wiring in `cli.ts`, using the pure selection + generalized loop guard from `persona-name-mapping-and-selection`.

- **`--as <name>` at the launch entry.** Parse `--as <name>` (strip it from the forwarded argv so netcage never sees it), resolve to the selected persona account (`anon-<name>`, default `anon`). An unknown persona (no such account / not provisioned) is a clear error ("no persona `<name>`; create it with `anon-pi persona add <name>`"), never a silent create or a silent fall-through to `anon`.
- **Generalized self-re-exec.** Replace v1's "am I `anon`?" guard at the launch entry with "am I the SELECTED persona account?" (the pure generalized guard). On a hardened install a login-user invocation re-execs via `sudo -u anon-<name> -i anon-pi …` (reuse `buildAnonSudoArgv` with the selected account); a process already running as the selected persona does not loop. The `--as` value must survive into the re-exec so the child launches as the right persona (or the child re-derives it as itself). `--version` stays local (no redirect), as v1.
- **Per-persona launch config.** After re-exec, the persona's own `config.json` (in its home) supplies its `proxy` — no new code needed beyond v1's config resolution running as the account, but assert the SELECTED persona's proxy is what reaches netcage, fail-closed per persona.
- **Preflight for the selected persona.** v1's preflight probe (`probeHardenedPreflight`) ALREADY takes an `account` param and `subidRangePresent` ALREADY checks only for an `<account>:` range line (not a specific start) — so the pure/probe layer needs NO reshape for decision 0's auto-allocation; it is already range-existence-based. The real change is at the CALL SITE(S): pass the SELECTED persona account instead of the hard-coded `ANON_ACCOUNT` wherever the preflight (and the re-exec) resolve the account. netcage `>= 0.11.0` floor unchanged.

Behaviour-preserving default: no `--as`, an existing v1 `anon` install redirects to `anon` and launches exactly as before.

Isolate tests (temp homes, fake sudo + tripwire fakes as v1's wiring tests did); no real sudo/su/podman/netcage.

## Acceptance criteria

- [ ] `--as <name>` selects persona `anon-<name>` at the launch entry, is STRIPPED from the forwarded argv (netcage never sees it), defaults to `anon` when absent, and errors clearly on an unknown/unprovisioned persona (no silent create, no silent fall-through to `anon`).
- [ ] The self-re-exec uses the SELECTED persona account (generalized guard): redirects when current != selected, no loop when already the selected persona; the selection survives into the re-exec. `--version` stays local.
- [ ] The SELECTED persona's own `config.json` proxy is what reaches netcage, fail-closed per persona (byte-identical refusal when absent); forced egress otherwise unchanged.
- [ ] The preflight is invoked for the SELECTED persona account (the account is threaded to `probeHardenedPreflight`/`evaluateHardenedPreflight` at the call site instead of the hard-coded `ANON_ACCOUNT`). NOTE: the probe already takes an account param and already checks range-existence-not-specific-start, so this is a call-site threading change, NOT a reshape of the probe/predicate. netcage floor `>= 0.11.0` unchanged.
- [ ] Default behaviour preserved: no `--as`, existing `anon` install launches exactly as v1 (regression-guarded by a test).
- [ ] Tests isolate the workspace (temp homes, fake sudo + tripwires), assert real homes untouched, no real sudo/su/podman/netcage/loginctl. TTY/CI discipline as the existing launch tests.
- [ ] Every change produces a changeset; the `verify` gate passes.

## Blocked by

- `persona-add-verb-wiring` — a persona must be provisionable before selecting it at launch; this task also relies on the mapper/guard (via that chain) and the reshaped preflight expectations.

## Prompt

> FIRST, check this task against current reality (launch snapshot; may have drifted): confirm v1's launch-entry self-re-exec hook (`maybeRedirectToAnon`), the `--as`-less launch path, `buildAnonSudoArgv`, `evaluateHardenedPreflight` + its probes, and the persona mapper/guard from the sibling all landed as assumed. This task GENERALIZES v1's single-account launch to the selected persona; keep the no-`--as` default byte-behaviour-identical. Route real drift to needs-attention.

You are wiring day-to-day persona selection into anon-pi's multi-persona hardened deployment (prd `multi-persona-hardened-accounts`). Domain (see `CONTEXT.md`): on a hardened install anon-pi re-execs itself into the dedicated account before doing anything (v1 did this for the single `anon`). Multi-persona makes it `anon-pi --as <name> …` -> re-exec into `anon-<name>` (default `anon`), launching with THAT persona's own proxy (from the persona's in-home config), fail-closed per persona. The `--as` value must be stripped from the argv netcage sees and must survive into the re-exec. An unknown persona errors (never silently creates or falls back to `anon`). The preflight is invoked for the selected persona (NOTE: `probeHardenedPreflight` already takes an account param and `subidRangePresent` already checks range-existence-not-a-specific-start, so this is threading the selected account to the call site, not reshaping the probe; netcage `>= 0.11.0` unchanged). Never weaken forced egress; the no-`--as` default must behave exactly like v1.

Goal: generalize v1's launch-entry self-re-exec (`maybeRedirectToAnon`) to the selected persona using the pure generalized guard + `buildAnonSudoArgv`, add `--as` parsing/stripping/error, ensure the selected persona's proxy reaches netcage fail-closed, and retarget the preflight to the selected account. Keep the impure layer thin.

Test with isolation (temp homes, fake sudo + tripwire fakes for podman/netcage/loginctl/su as v1's wiring tests did): `--as` selects + strips + errors on unknown; redirect targets the selected persona + loop-guards; no-`--as` default == v1 (regression test); fail-closed per persona. "Done" = launch selection wired + tests green under the verify gate, with a changeset committed.

> RECORD non-obvious in-scope decisions (how `--as` survives the re-exec; the unknown-persona error surface) as an ADR if they meet the gate, else a `## Decisions` note. Coordinate the superseding ADR with `persona-adr-and-docs`.
