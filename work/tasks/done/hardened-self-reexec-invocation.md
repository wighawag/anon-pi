---
title: Hardened self-re-exec invocation + always-redirect predicate (pure)
slug: hardened-self-reexec-invocation
prd: hardened-dedicated-account-deployment
blockedBy: []
covers: [3, 4]
---

## What to build

The PURE core of the hardened invocation: how anon-pi, when configured to run under the dedicated `anon` account, redirects a login-user invocation into that account by re-executing ITSELF via `sudo`. No wrapper script exists; anon-pi is its own wrapper.

Deliver in the pure module (`src/anon-pi.ts`):

- A **should-redirect predicate**: given (is-this-install-hardened?, the current effective user identity) it decides whether anon-pi must re-exec as `anon`. On a hardened install, redirect is ALWAYS chosen when the caller is NOT already `anon` (option A: there is no non-hardened bypass on a hardened box); when already running as `anon` it must NOT redirect (else infinite loop). Both inputs are INJECTED (the "am I anon?" probe is the impure seam, e.g. a `getuid`/username lookup passed in), so the predicate stays pure.
- An **invocation argv builder**: composes the primary `['sudo', '-u', 'anon', '-i', '<abs-anon-pi-path>', ...forwardedArgs]` (the login `-i` form, so `$HOME`/`$XDG_RUNTIME_DIR`/env become `anon`'s, which rootless podman needs) and the documented fallback `su - anon -c '<anon-pi> ...'` string form. The absolute anon-pi path is an input (resolved by the caller), not hard-coded.

Keep it consistent with the repo's pure-planner + injected-spawn style (mirror the existing `AnonPiEnv` injection and the `exists`-style injected probes): the actual `exec`/`spawn` is done by `cli.ts` (a later task wires it), NOT here. This task adds ONLY the pure predicate + builder and their tests. Do NOT change the normal (non-hardened) launch path's behaviour.

## Acceptance criteria

- [ ] A pure should-redirect predicate returns "redirect" on a hardened install when the caller is not `anon`, and "do not redirect" when the caller already IS `anon` (no self-loop) or when the install is not hardened.
- [ ] A pure argv builder produces the exact `sudo -u anon -i <abs-anon-pi> <args...>` argv (login form) and the `su - anon -c` fallback string, with the anon-pi path and forwarded args injected.
- [ ] The "am I anon?" identity check and the anon-pi path are INJECTED seams (no `getuid`/`process.execPath`/`whoami` called inside the pure functions).
- [ ] anon-pi sets no uid and ships no setuid binary: the design re-execs by SPAWNING `sudo` only (asserted structurally, i.e. the builder only ever emits a `sudo`/`su` argv, never a privilege syscall).
- [ ] Tests cover the new behaviour (mirror the repo's pure-module test style in `packages/anon-pi/test/`): hardened+not-anon -> redirect; hardened+anon -> no redirect; not-hardened -> no redirect; argv/string shape for both forms.
- [ ] No test invokes real `sudo`/`su`; the exec is not performed in this task at all (pure logic only).
- [ ] This task OWNS the hardened-dedicated-account ADR: author `docs/adr/0006-hardened-dedicated-account.md` (per `docs/adr/` numbering, following ADR-FORMAT) recording the durable decisions — account name `anon`, self-re-exec (not a wrapper, not setuid), always-redirect on a hardened install (option A), password-kept-by-default, and the netcage uid-scoped-store dependency. Sibling tasks EXTEND it; they do not re-create it.
- [ ] This task PINS the new vocabulary in `CONTEXT.md`: add glossary entries for the dedicated `anon` account, the hardened deployment / DAC discoverability boundary, and self-re-exec, so the term cannot be re-forked (the old idea note drifted `netuser` vs `anon`).
- [ ] Every change produces a changeset (`pnpm changeset`); the `verify` gate (`pnpm format:check && pnpm changeset status --since=main && pnpm -r build && pnpm -r test`) passes.

## Blocked by

- None — can start immediately.

## Prompt

> FIRST, check this task against current reality (launch snapshot; may have drifted): confirm `src/anon-pi.ts` still holds the pure logic and `src/cli.ts` the spawn/TUI (the pure/impure split), and that the injected-probe pattern (e.g. `exists: (p) => boolean` passed into resolvers) is still the idiom. If the split changed, route to needs-attention rather than build on a stale premise.

You are adding the hardened-deployment invocation core to anon-pi (a host-side launcher for the netcage jail). Domain (see `CONTEXT.md` and the prd `hardened-dedicated-account-deployment`): anon-pi keeps anonymized work under `~/.anon-pi`; the hardened deployment runs that whole workspace under a single dedicated Unix account named `anon` so a host coding agent running as your normal login user cannot casually `find`/`grep` your session transcripts. The crossing is a DELIBERATE act gated by a sudo password; this is a discoverability boundary, not hard containment (root/blanket-sudo defeats it).

Goal: land the PURE should-redirect predicate + the `sudo -u anon -i anon-pi "$@"` (and `su - anon -c` fallback) argv/string builder in `src/anon-pi.ts`. Auto-redirect is ALWAYS on a hardened install (option A, confirmed): every login-user invocation redirects to `anon`; only a caller that already IS `anon` skips it (no self-loop). anon-pi is its OWN wrapper (self-re-exec) — there is no separate `anon` wrapper file anywhere in this feature. anon-pi spawns `sudo`; it never sets a uid and ships no setuid binary. Keep the "am I anon?" identity probe and the anon-pi binary path as INJECTED seams so the logic is pure and unit-testable; the actual exec lands in the later init/cli-wiring task, not here.

Test at the pure predicate + builder seam: hardened+not-anon redirects, hardened+anon does not (loop guard), not-hardened does not, and both argv/string forms are exact. Do NOT touch the normal launch path. "Done" = the pure predicate + builder + tests are green under the verify gate, with a changeset committed.

> RECORD non-obvious in-scope decisions as an ADR (`docs/adr/`) if they meet the ADR gate, else a `## Decisions` note in the done record. (The hardened-dedicated-account ADR — account name `anon`, self-re-exec, always-redirect, password-kept — is expected to be authored alongside this first task if not already present.)
