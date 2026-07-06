---
title: Standalone `anon-pi harden` verb (re-harden an existing install, with workspace import)
slug: harden-command-with-import
---

# Standalone `anon-pi harden` verb, with existing-workspace import

Deferred out of the v1 hardened-dedicated-account feature (see prd `hardened-dedicated-account-deployment`). v1 ships hardening only through `init` (which auto-runs on an uninitialised anon-pi and now ASKS whether to run under a dedicated `anon` account). A fresh `init` has nothing to import, so v1 sidesteps the migrate question entirely. This idea captures the piece that was postponed: a standalone `harden` verb that re-hardens a machine that ALREADY has anonymized work under the login user's `~/.anon-pi`.

## Why it was deferred

The value of a standalone `harden` (over the init path) is the RE-RUN-on-a-populated-workspace case: a user who has been running normal (non-hardened) anon-pi and now wants their existing homes/projects/session transcripts moved BEHIND the DAC boundary. That is precisely an IMPORT/migrate step, and importing existing work is its own machinery (overlaps the separate `import-repo-into-project` idea). Rather than block v1 on the migrate design, v1 ships init-driven hardening only; this verb is the follow-up.

## The open question this idea owns (moved out of the prd)

When `harden` runs on a machine with a populated login-user `~/.anon-pi` (homes, projects, session transcripts, config), what happens to that existing work, which is exactly the anonymized work the feature exists to get out of casual reach? Three behaviours:

- **(a) migrate/import:** move the existing `~/.anon-pi` into `anon`'s tree, `chown` to `anon`, `chmod 700`. A cross-user `chown` needs root, so it is EMITTED INTO the Tier-2 generated root script (anon-pi never silently sudo's), not done in Tier 1.
- **(b) start fresh:** leave the login-user workspace untouched; `anon`'s tree starts empty.
- **(c) leave-and-warn:** don't touch it, but WARN loudly that the old workspace stays discoverable under the login user (the exact leak being closed) and print how to migrate or delete it.

Prior lean (to revisit when this is picked up): non-interactive DEFAULT = **(c) leave-and-warn** (no surprising cross-user file moves; the warning names the residual leak). **(a) migrate** available via an explicit `--migrate` flag, as a THIN relocate + `chown` only (NOT content-level anonymization; rewriting identifiers inside the migrated tree stays with the `import-repo-into-project` idea). **(b) fresh** via an explicit `--fresh` that silences the warning. Interactive `harden` PROMPTS; the default governs only the non-interactive path.

## Shape (reuses the v1 engine)

`harden` would reuse the v1 hardening pieces wholesale: the preflight predicates, the Tier-2 root-script generator, and the self-re-exec invocation logic. It ADDS only the existing-workspace decision layer (detect a populated login-user `~/.anon-pi`, pick a policy, emit the migrate `chown`+`mv` lines into the Tier-2 script for the migrate path). So this is a small delta over v1 once the import design is settled.

## Dependencies / links

- Builds on prd `hardened-dedicated-account-deployment` (v1 must ship first).
- The migrate path's content-level concerns overlap the `import-repo-into-project` idea (`work/notes/ideas/import-repo-into-project.md`); the deep rewrite stays there, `harden` only does the thin relocate + `chown`.
- Same netcage dependency as v1 (uid-scoped store, netcage >= 0.11.0). Does NOT set `NETCAGE_GRAPHROOT`.
- Same never-silent-root invariant: Tier 2 (including the migrate `chown`) is GENERATED and run by the human.
