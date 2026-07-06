# Hardened deployment under a single dedicated `anon` account (self-re-exec, always-redirect)

## Status

Accepted. Formalizes prd `hardened-dedicated-account-deployment`. Sibling tasks (preflight, tier-2 script, init step, docs) EXTEND this ADR; they do not re-create it.

## Context

anon-pi keeps anonymized work (machine homes, project dirs, session transcripts under `~/.anon-pi/`) inside the login user's `$HOME`. A DIFFERENT coding agent running on the host as that same login user can casually `find`/`grep` its way onto those transcripts ("find my previous conversation about X"), re-associating anonymized activity with the operator. This is an ACCIDENTAL-discovery threat (an unprivileged host agent being too casual), NOT a determined or root attacker: plain Unix DAC (a dedicated account owns the workspace mode-700, the login user is not in it) is the right defense. A host agent with root or blanket passwordless sudo defeats it entirely; that is documented, not defended.

## Decision

Run anon-pi's whole workspace under a SINGLE dedicated Unix account named **`anon`**, and make anon-pi its own re-exec wrapper.

- **Account name `anon`.** One canonical, shared, non-per-persona name, pinned in code (`ANON_ACCOUNT`) and `CONTEXT.md` so it can never be re-forked (the superseded idea note drifted `netuser` vs `anon`).
- **Self-re-exec, not a wrapper, not setuid.** When a hardened-configured install is invoked by the login user, anon-pi RE-EXECS ITSELF as `anon` by SPAWNING `sudo -u anon -i <abs-anon-pi> "$@"` (the login `-i` form, so `$HOME`/`$XDG_RUNTIME_DIR`/env become `anon`'s, which rootless podman under a lingering account needs); `su - anon -c '<anon-pi> …'` is the documented fallback where sudoers is not configured. There is NO separate `anon` wrapper file to write or install, and anon-pi ships NO setuid binary and sets NO uid: it only ever spawns `sudo`/`su`.
- **Always-redirect (option A).** On a hardened install EVERY login-user invocation auto-redirects to `anon`; only a caller that already IS `anon` skips it (the loop guard, else infinite self-re-exec). There is no "run non-hardened on this box too" mode (prd story 9 coexistence dropped): a non-hardened install is simply a box you did not harden. This trades coexistence for a much smaller surface and closes the accidental-leak path where a login-user call would write into `~/.anon-pi`.
- **Password kept by default.** No `NOPASSWD` sudoers rule by default: the sudo password is what makes crossing DELIBERATE, so a host agent never trips into the boundary. sudo's ~15-min cache keeps day-to-day use to at most one prompt. An opt-in `--nopasswd` is OFF by default, for a single-user trusted box only.
- **netcage dependency is the UID-SCOPED store, not a private-path knob.** Running netcage as `anon` auto-scopes its store to that uid (netcage ADR-0017 / prd `uid-scoped-graphroot-multi-user-fix`), so it does not collide with the login user's store. anon-pi does NOT set `NETCAGE_GRAPHROOT`. The dependency is "netcage new enough (>= 0.11.0) to have the uid-scoped store", asserted by the preflight (a sibling task).

## Considered Options

- **A separate `anon` wrapper command on PATH** (the superseded idea note's shape). Rejected: it is another file to write, name, install, and keep in sync, and it must coexist with the real binary. Self-re-exec needs none of that.
- **setuid / a raw uid change inside anon-pi.** Rejected: it would make anon-pi a privileged binary the operator must trust with uid switching. Spawning `sudo` keeps anon-pi a rootless npm launcher that never grabs privilege.
- **Coexisting a non-hardened install on a hardened box** (run-normally-too mode). Rejected for v1: it re-introduces a wrapper and an accidental-leak path; simply not hardening a box gives the non-hardened behaviour.

## Consequences

- The PURE decision + composition land first (this task): a `shouldRedirectToAnon` predicate (loop-guarded, always-on-hardened) and `buildAnonSudoArgv` / `buildAnonSuFallback` builders, with the "am I anon?" identity and the anon-pi path as INJECTED seams. The actual exec is wired in cli.ts by a later task.
- This defends ONLY against an unprivileged host agent; root/blanket-sudo defeats it. Any docs must state this loudly (a sibling docs task owns it).
