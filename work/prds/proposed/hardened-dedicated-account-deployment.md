---
title: Hardened deployment under a single dedicated `anon` Unix account (out of a host agent's casual reach)
slug: hardened-dedicated-account-deployment
humanOnly: true
needsAnswers: true
---

> Launch snapshot - records intent at creation, NOT maintained. Current truth: `docs/adr/` (decisions) + the code; remaining work: `work/tasks/`. The technical detail below seeds the tasking and is trimmed once tasked.

<!-- open-questions -->
<!--
  TRANSIENT BLOCK - stripped by the apply rung on full resolution.
  This prd captures a design discussed on the netcage side and needs the answers CONFIRMED in anon-pi's own context before tasking. Resolve the Open questions, clear needsAnswers, and delete this block.
-->

## Open questions

Most of the design is now CONFIRMED (recorded inline below and in Implementation Decisions). ONE genuine decision remains open and blocks tasking: the existing-workspace migration default (question 1). The rest are settled and kept here only as a short confirmed-decision ledger.

1. **OPEN: on `harden`, what happens to an EXISTING login-user workspace (migrate vs fresh)?** This is the "where does harden ask to import?" seam. When `anon-pi harden` runs on a machine that already has a populated `~/.anon-pi` under the LOGIN user (homes, projects, session transcripts, config), it must decide the fate of that existing work, which is precisely the anonymized work this feature exists to get out of casual reach. Three behaviours:
   - **(a) migrate/import:** move the existing `~/.anon-pi` into `anon`'s tree (`~anon/.anon-pi`), `chown` to `anon`, `chmod 700`. Because a cross-user `chown` needs root, this step is EMITTED INTO THE TIER-2 GENERATED SCRIPT (anon-pi cannot `chown` to `anon` rootlessly and never silently sudo's), not done in Tier 1.
   - **(b) start fresh:** leave the login-user workspace untouched; `anon`'s tree starts empty.
   - **(c) leave-and-warn:** don't touch it, but WARN loudly that the old workspace stays discoverable under the login user (the exact leak being closed) and print how to migrate or delete it.
   `harden` should PROMPT interactively (or take `--migrate`/`--fresh`), and `init --hardened` on a fresh install has nothing to import so it skips the prompt. DECIDE the DEFAULT when non-interactive/unspecified: leaning (c) leave-and-warn as the safe default (no surprising cross-user file moves; the warning names the risk), with (a) available explicitly. Confirm the default and whether migrate is offered at all in v1 or deferred (it could lean on the separate `import-repo-into-project` idea's machinery).

Confirmed decisions (settled in discussion; no longer open):

2. **Account name = `anon`; wrapper command = `anon`.** Single shared dedicated account (not per-persona). One canonical name for both the Unix account and the convenience wrapper.
3. **Invocation = `sudo -u anon -i anon-pi "$@"` primary**, `su - anon -c 'anon-pi ...'` documented fallback; a tiny `anon` wrapper `exec`s the primary. anon-pi implements NO privilege-switching (shells out). **Password KEPT by default** (no `NOPASSWD` sudoers rule): the password is what makes crossing deliberate, so a host agent never trips into it; sudo's ~15-min cache keeps day-to-day use to one prompt. (An opt-in `--nopasswd` is OFF by default, for a single-user trusted box only.)
4. **BOTH entry points, one engine:** a standalone `anon-pi harden` verb AND `anon-pi init --hardened`, sharing a single hardening engine. `harden` is the full flow (Tier-1 rootless setup + preflight + emit Tier-2 root script) runnable anytime, and is where the existing-workspace question (question 1) is asked. `init --hardened` runs the same engine as first-time onboarding (nothing to import on a fresh install). Both idempotent/re-runnable.
5. **netcage dependency = the UID-SCOPED-STORE fix, NOT a private-path knob.** anon-pi does NOT set `NETCAGE_GRAPHROOT`: running netcage as `anon` auto-scopes its store to that uid (netcage ADR-0017 / prd `uid-scoped-graphroot-multi-user-fix`), so it does not collide with the login user's store. The preflight asserts netcage is new enough to have the uid-scoped store. (See Further Notes for why the old private-path framing was dropped.)
6. **Changeset + verify gate applies.** anon-pi's `.dorfl.json` verify is `pnpm format:check && pnpm changeset status --since=main && pnpm -r build && pnpm -r test`; every task emitted from this prd adds a `pnpm changeset` and stays green under it (unlike netcage, this repo really does use changesets).

<!-- /open-questions -->

## Problem Statement

You run anon-pi to do anonymized work, but the work it keeps (machine homes, project dirs, session transcripts under `~/.anon-pi/machines/*/home/.pi/agent/sessions/`) sits in YOUR login user's `$HOME`. A DIFFERENT coding agent running on the host as your normal login user can casually surface it: you ask that host agent "find my previous conversation about X" or "where's that work folder", and it `grep`s / `find`s your `$HOME` and stumbles onto the anonymized recon work. In an AI-driven project the session transcript basically IS the work, so surfacing it re-associates "anonymized" activity with you.

This is an ACCIDENTAL-discovery threat model, not a determined attacker. The adversary is you being too casual with your own host agent, not something trying to break out of the jail (the in-jail anon-pi agent is already confined and cannot reach the host store; that is netcage's job and is unchanged). The defense is plain Unix DAC: a dedicated account owns the workspace mode-700, your login user is not in it, so a casual `find`/`grep` as you simply cannot read those files.

Caveat that must be stated loudly in any docs: this defends against an UNPRIVILEGED host process/agent running as your login user. A host agent with root (or blanket passwordless sudo) defeats it entirely (root ignores DAC). If your host agents run with broad sudo, this buys little.

## Solution

Run anon-pi's whole workspace under a SINGLE dedicated Unix account (`anon`), invoked from your normal login user via `sudo`/`su`, with anon-pi actively helping to SET UP and CHECK the account without ever grabbing root silently.

From the user's perspective:

- You run a one-time `anon-pi harden` (or `anon-pi init --hardened` on a fresh machine, same engine) that does the rootless setup on anon-pi's side and PRINTS a reviewable, root-requiring script for the parts that need root (creating the `anon` account, subuid/subgid ranges, linger, the scoped sudoers snippet, and, if you chose to migrate, the cross-user `chown` of your existing workspace into `anon`'s tree). You review and run that script with sudo yourself. anon-pi never sudo's silently.
- If you already have anonymized work under your login user's `~/.anon-pi`, `harden` asks what to do with it (migrate into `anon`'s tree, start fresh, or leave-and-warn); see Open question 1.
- Day to day you run a tiny `anon` wrapper (which `exec`s `sudo -u anon -i anon-pi "$@"`); the first call prompts for the sudo password, subsequent calls within sudo's cache window do not. Your host agent's "find my work" never types that password, so it never crosses the boundary.
- Your anonymized work now lives under the `anon` account's mode-700 home, invisible to your login user's casual searches. The workspace files, and (because netcage runs as `anon`) netcage's container store too, are all under the dedicated account.

The whole thing is Unix DAC plus ergonomics. anon-pi implements NO privilege-switching itself: it shells out to `sudo`/`su` and generates the provisioning script. The netcage side needs NO private-path knob: netcage's uid-scoped store (ADR-0017) means running as `anon` gives netcage a distinct, non-colliding store automatically.

## User Stories

1. As an operator, I want my anonymized work kept under a dedicated account's mode-700 home, so that a host agent running as my login user cannot `find`/`grep` its way onto my session transcripts.
2. As an operator, I want crossing into the dedicated account to require a sudo PASSWORD by default, so that an over-eager host agent never trips into my anonymized work automatically; crossing is a deliberate act I perform.
3. As an operator, I want a tiny `anon` command that transparently runs anon-pi as the `anon` account, so that day-to-day use is `anon recon` with at most one password prompt (sudo caches it), not a manual shell hop every time.
12. As an operator hardening an EXISTING install, I want `harden` to ask what to do with my current login-user `~/.anon-pi` (migrate it behind the boundary, start fresh, or leave-and-warn) rather than silently move or silently abandon it, so that my existing anonymized work is handled by an explicit choice. (Migration is a cross-user `chown`, so it is emitted into the Tier-2 root script, never done silently.)
4. As an operator, I want anon-pi to NEVER silently sudo or grab root, so that I can install a rootless npm launcher without trusting it with privilege.
5. As an operator, I want anon-pi to GENERATE a reviewable, root-requiring provisioning script (create the account, subuid/subgid ranges, `loginctl enable-linger`, the scoped sudoers snippet) that I run myself, so that the root-needing parts are explicit and auditable, not hidden.
6. As an operator, I want a preflight that CHECKS the account is set up correctly (subuid/subgid ranges present, linger on, `/dev/net/tun` accessible, `$XDG_RUNTIME_DIR` present for the account, netcage new enough for the uid-scoped store) and prints exactly what is missing, so that a half-provisioned account fails loudly with remediation, not cryptically.
7. As an operator, I want anon-pi's workspace (`ANON_PI_HOME`) to point into the dedicated account's tree and be `chmod 700`, so that all three leak surfaces (workspace, session store, config) sit behind the DAC boundary.
8. As an operator, I want netcage to run correctly as the dedicated account with NO extra configuration, so that its container store lands in the account's uid-scoped path automatically and does not collide with my login user's store. (This relies on netcage's uid-scoped-store fix; anon-pi does not set `NETCAGE_GRAPHROOT`.)
9. As an operator on a machine that ALSO has a normal (non-hardened) anon-pi install, I want the hardened wrapper + account to coexist without clobbering the normal install, so that I can run both on one host.
10. As an operator, I want the docs to state plainly that this defends only against an UNPRIVILEGED host agent (root / blanket sudo defeats it), so that I do not over-trust the boundary.
11. As an operator, I want this to compose with the ephemeral-run idea (a run that saves nothing), so that "nothing to find" and "what I keep is out of casual reach" stack (belt and suspenders).

### Autonomy notes (the two gate axes)

- **`humanOnly: true`:** SET. This encodes a security boundary + a root-provisioning flow + a cross-repo assumption about netcage's version; a human should drive its tasking so the design (account name, invocation, password policy, verb surface, migration default) is ratified, not auto-fanned. It does not propagate to the tasks' own build-gates.
- **`needsAnswers: true`:** SET. One genuine decision remains (Open question 1: the migrate-vs-fresh default for an existing workspace). The rest are confirmed. Clear the flag once the migration default is decided.

## Implementation Decisions

Confirmed decisions (durable rationale to move into an anon-pi ADR at tasking):

- **Single dedicated account named `anon`** (not per-persona). One DAC boundary for all anonymized work. The convenience wrapper is also `anon`.
- **Two entry points, one engine:** a standalone `anon-pi harden` verb (full flow, runnable anytime, hosts the existing-workspace question) and `anon-pi init --hardened` (first-time onboarding running the same engine). Both idempotent/re-runnable.
- **Two-tier "actively help", never silent root:**
  - **Tier 1 (rootless, anon-pi does directly, once the account exists):** set `ANON_PI_HOME` into the `anon` account's tree, `chmod 700` the workspace, write the `anon` convenience wrapper (`exec sudo -u anon -i <path>/anon-pi "$@"`), and run the preflight. Does NOT set `NETCAGE_GRAPHROOT` (netcage's uid-scoped default handles the store).
  - **Tier 2 (needs root, anon-pi GENERATES but does NOT EXECUTE):** emit a ready-to-run, reviewable script (`useradd anon`, `/etc/subuid` + `/etc/subgid` lines, `loginctl enable-linger anon`, the scoped sudoers snippet, and the existing-workspace `chown` IF migrate was chosen) and tell the user to review + run it with sudo. Never silently sudo's.
- **Invocation:** `sudo -u anon -i anon-pi "$@"` primary (login form so `$HOME`/`$XDG_RUNTIME_DIR`/env are `anon`'s, which rootless podman needs); `su - anon -c 'anon-pi ...'` documented fallback where sudoers is not configured. anon-pi shells out; it implements no privilege logic.
- **Password kept by default.** No `NOPASSWD` sudoers rule shipped by default (the password is the deliberate-crossing feature). The scoped sudoers snippet is narrow: `<login-user> ALL=(anon) <anon-pi-binary>`, for just the anon-pi binary as `anon`. (An opt-in `--nopasswd` is OFF by default.)
- **Existing-workspace handling (migrate / fresh / leave-and-warn)** is asked by `harden`; the migrate path's cross-user `chown` goes in the Tier-2 script. The non-interactive DEFAULT is the one Open question (question 1).
- **netcage dependency is the uid-scoped store**, not a private-path knob (see Further Notes). Preflight checks netcage's version. anon-pi does not set `NETCAGE_GRAPHROOT`.

## Testing Decisions

Good tests assert anon-pi's own composition/logic with the OS seams stubbed (anon-pi's existing style: pure planners + injected impure spawn seams, tests stub `spawnSync`/`spawn`):

- **Wrapper + invocation composition (unit):** the `anon` wrapper composes the correct `sudo -u anon -i <anon-pi-path> "$@"` argv (and the `su - anon -c` fallback form), asserted as a pure string/argv builder with the actual exec stubbed. No real sudo in unit tests.
- **Existing-workspace decision (unit):** given a detected login-user `~/.anon-pi` and a chosen policy (migrate/fresh/leave-and-warn), the engine produces the right plan (Tier-2 `chown` lines for migrate; the warning text for leave-and-warn; nothing for fresh), as pure logic over injected filesystem-probe results. No real cross-user moves in tests.
- **Tier-2 script generation (unit):** the emitted provisioning script contains the expected `useradd` / subuid+subgid / `enable-linger` / sudoers lines for the chosen account name, as a pure generator (assert the text), never executed in tests.
- **Preflight checks (unit):** each check (subuid/subgid present, linger on, `/dev/net/tun` accessible, account `$XDG_RUNTIME_DIR`, netcage version) is a pure predicate over injected probe results; missing pieces produce the exact remediation message. The real probes are the injected impure seam, stubbed in tests.
- **Tier-1 setup (unit):** `ANON_PI_HOME` resolution into the account tree + `chmod 700` intent + wrapper-write are composed logic with the filesystem/exec seams stubbed; no real writes outside a temp dir.
- **No real privilege / no real account** in any test. Everything OS-touching is an injected seam. Follows the repo rule: unit tests invoke no real netcage/podman/sudo and touch no shared/global location.
- **Changeset + verify:** every task adds a `pnpm changeset` and stays green under `pnpm format:check && pnpm changeset status --since=main && pnpm -r build && pnpm -r test`.

## Out of Scope

- **Hard containment against a determined/malicious or root host agent.** This is a DISCOVERABILITY boundary (accidental discovery by an unprivileged agent). Root/blanket-sudo defeats it; documented, not defended.
- **A narrow launch-only gateway / no-interactive-shell-as-`anon` hardening.** Not needed for the accidental-discovery model (that complexity is for defeating a malicious agent). A normal `sudo -u anon -i anon-pi ...` with all verbs intact is fine.
- **anon-pi implementing privilege-switching itself.** It shells out to `sudo`/`su`; it never sets uid or ships a setuid binary.
- **anon-pi silently running root commands.** Tier 2 is GENERATED and run by the human, never executed by anon-pi.
- **netcage changes.** The netcage side is the uid-scoped-store fix, owned in the netcage repo (ADR-0017 / prd `uid-scoped-graphroot-multi-user-fix`). This prd DEPENDS on a netcage version that has it; it does not modify netcage. In particular anon-pi does NOT set `NETCAGE_GRAPHROOT` (the uid-scoped default suffices).
- **Store-privacy from host processes (hide the store via a mode-700 netcage graphroot).** DROPPED. This was the prior idea note's framing; it is not a goal (the operator does not care about host-process discoverability of the store, only about the workspace/session files, which the account's mode-700 home already covers, and about the in-jail login-name leak, which is netcage's concern). See Further Notes.
- **Per-persona / multiple dedicated accounts.** Out of scope; a single account named `anon` is confirmed.
- **Deep migration tooling** (rewriting git history, scrubbing identifiers inside the migrated workspace). The migrate path only relocates + `chown`s the existing `~/.anon-pi` behind the boundary; it does not rewrite its contents. Content-level anonymization is the separate `import-repo-into-project` idea's concern.

## Further Notes

- **This prd supersedes the idea note `work/notes/ideas/hardened-dedicated-account-deployment.md`** (same slug). That note should be updated or retired once this prd is tasked. It is largely correct, but its netcage dependency was framed WRONG and must not be carried forward verbatim (see below).
- **Corrected netcage dependency (important):** the idea note said netcage's graphroot must move to a `netuser`-private mode-700 path (store-privacy from host processes), BLOCKED-ON a netcage `private-graphroot` knob. On the netcage side this was reviewed and CORRECTED:
  - The operator does NOT care about hiding the store from other host processes (Observer 2). That threat model is out of scope.
  - The only host-identity concern is Leak 2: the IN-JAIL tool reading the operator's login NAME from `/proc/self/mountinfo`. netcage's fixed `/var/tmp/netcage-storage` already scrubbed the graphroot half of that; the REMAINING half is the `-v` bind-mount SOURCE paths, which anon-pi closes by RUNNING AS the `anon` account (so the mount sources read `/home/anon/...`, a throwaway name, not the operator's real login name). That is exactly THIS prd's job.
  - The actual netcage problem was a MULTI-USER COLLISION BUG: its fixed `/var/tmp/netcage-storage` is one shared path, so a second Unix user (like `anon`) running netcage collides with the first user's store. netcage fixed this by UID-SCOPING the default (`/var/tmp/netcage-storage-<uid>`, netcage ADR-0017 / prd `uid-scoped-graphroot-multi-user-fix`). So running as `anon` now gives netcage a distinct, non-colliding store with no knob.
  - NET EFFECT for anon-pi: the dependency is "netcage new enough to have the uid-scoped store", NOT "netcage exposes a private-path knob". anon-pi does not set `NETCAGE_GRAPHROOT`. The three-things-must-move list from the idea note collapses to TWO that are anon-pi's (workspace/config via `ANON_PI_HOME`; running as the account), because netcage's store now handles itself.
- **Cross-repo dependency (explicit):** BLOCKED-ON netcage shipping the uid-scoped graphroot store (netcage prd `uid-scoped-graphroot-multi-user-fix`). Until a netcage release carries it, running netcage as `anon` would collide on the shared `/var/tmp` store. The preflight (story 6) should assert the netcage version.
- **`runroot` / transient podman state:** podman's rootless default runroot is `$XDG_RUNTIME_DIR/containers`, per-user by construction, so under a lingering dedicated account it is already the account's and does not need moving. The idea note's uncertainty here is resolved: nothing to do, provided linger is enabled (which the preflight checks).
- **Composes with** the `--ephemeral` / ephemeral-home ideas (nothing kept to find) and, if netcage ever ships a tmpfs-backed forensic tier, that is a SEPARATE stronger concern, not required here.
- **This is a DESIGN deliverable at drafting time.** No code and no tasking were performed; the draft stops here for the confirmation of the Open questions.
