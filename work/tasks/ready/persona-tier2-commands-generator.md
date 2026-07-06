---
title: Reshape the Tier-2 generator to copy-paste commands + auto-allocated subid (pure, supersedes v1 script-file)
slug: persona-tier2-commands-generator
prd: multi-persona-hardened-accounts
blockedBy: [persona-name-mapping-and-selection]
covers: [7]
---

## What to build

Reshape v1's Tier-2 provisioning generator (`buildTier2ProvisioningScript` in `src/anon-pi.ts`) per the PRD's decisions 0 + 8. This SUPERSEDES the v1 shape for BOTH the default `anon` and every persona.

Two changes:

1. **Emit COPY-PASTE COMMANDS, not a `#!/bin/sh` script file.** v1 returned a `#!/bin/sh` + `mktemp` script the human saves/runs. Instead, produce a block the human PASTES into a root shell they enter first: first the "become root" line (`sudo -i` or `su -`), then the plain provisioning commands. anon-pi PRINTS this (never writes a file, never executes). Rationale: no on-disk script to leak the persona name, nothing to save; running inside a root shell keeps the persona name out of the sudo/command audit log (the single `sudo -i` carries no name; commands typed in a root shell are not individually audited). Keep the v1 safety touches AS pasted commands: create the account with `useradd -m <account>`; `loginctl enable-linger <account>`; install the scoped sudoers rule `<login-user> ALL=(<account>) <anon-pi>` (password kept by default; opt-in `--nopasswd`) VALIDATED with `visudo -cf` before `install` mode-0440.
2. **Drop the hard-coded subuid/subgid range; let `useradd` auto-allocate.** Remove the `SUBID_RANGE_START`/`SUBID_RANGE_COUNT` explicit `/etc/subuid`+`/etc/subgid` range lines; trust `useradd -m` to allocate a free non-overlapping block (modern shadow-utils, `SUB_UID_COUNT`/`SUB_GID_COUNT`). This removes range-collision math and makes N personas each get a distinct block for free.

**RIPPLE (this task owns ALL of it, in one green step) — removing `SUBID_RANGE_COUNT`/`SUBID_RANGE_START` breaks more than the generator:**
- `subidRemediation()` in `src/anon-pi.ts` currently embeds `SUBID_RANGE_COUNT` and says it "appends `<account>:<start>:<count>`". Reword it: the account's subid range is now auto-allocated by `useradd -m` (no appended line), so the remediation should say "run the printed provisioning commands (which `useradd -m <account>`)" and NOT reference a specific range.
- `test/hardened-preflight.test.ts` imports `SUBID_RANGE_COUNT` and asserts the remediation `toContain(String(SUBID_RANGE_COUNT))` — update it to the reworded remediation.
- `test/hardened-orchestrator.test.ts` imports + calls `buildTier2ProvisioningScript` — update its expectations to the copy-paste-commands shape.
- `test/hardened-provisioning.test.ts` (the generator's own tests) — the primary rewrite.
Grep the tree for `SUBID_RANGE_START`/`SUBID_RANGE_COUNT`/`buildTier2ProvisioningScript`/`#!/bin/sh` and update EVERY reference so the gate stays green; this is a coordinated single-commit reshape, not just the generator body.

The generator stays PURE (account, login user, anon-pi path injected) and is still asserted as a STRING; never executed. Account is now the parameterized persona account (`anon-<name>` or the default `anon`), from the mapping task.

## Acceptance criteria

- [ ] The generator emits copy-paste commands (a "become root" line: `sudo -i`/`su -`, then the provisioning commands), NOT a `#!/bin/sh` script file; no `mktemp`-to-a-saved-script framing implying the user saves a file.
- [ ] No explicit `/etc/subuid`+`/etc/subgid` range line is emitted; account creation is `useradd -m <account>` (subid auto-allocated). `SUBID_RANGE_START`/`SUBID_RANGE_COUNT` are removed, and EVERY reference is updated in the same green step: `subidRemediation()` reworded (no range-count), `test/hardened-preflight.test.ts` (drops the `SUBID_RANGE_COUNT` import + assertion), `test/hardened-orchestrator.test.ts` (generator-shape expectations), `test/hardened-provisioning.test.ts` (the generator's own tests). A tree grep for the removed symbols returns nothing.
- [ ] Emits `loginctl enable-linger <account>` and the scoped sudoers rule `<login-user> ALL=(<account>) <anon-pi>`, password KEPT by default, opt-in `--nopasswd`, with `visudo -cf` validation before install.
- [ ] Emits NO cross-user `chown`/migration line and NO `NETCAGE_GRAPHROOT` export (unchanged from v1).
- [ ] Works for both the default `anon` and a persona `anon-<name>` (account injected).
- [ ] Tests assert the presence/shape of each pasted command, the password-kept default + opt-in nopasswd, the absence of the range line / chown / graphroot, and that no script FILE is written (pure string only). The v1 `hardened-provisioning` tests that asserted the range line + `#!/bin/sh` shape are updated to the new shape.
- [ ] Every change produces a changeset; the `verify` gate passes.

## Blocked by

- `persona-name-mapping-and-selection` — the account parameterization (default `anon` vs `anon-<name>`) this generator emits for.

## Prompt

> FIRST, check this task against current reality (launch snapshot; may have drifted): read the CURRENT `buildTier2ProvisioningScript` + its `hardened-provisioning` tests, and confirm the mapping task landed the account parameterization. This task CHANGES v1's shipped shape (retires the script file + the hard-coded range), so it must update the v1 tests that pin the old shape, in the same green step. If the generator already moved, build on it.

You are reshaping the Tier-2 root-provisioning generator for anon-pi's multi-persona hardened deployment (prd `multi-persona-hardened-accounts`, supersedes ADR-0006). Domain: creating a dedicated account needs root; anon-pi NEVER silently sudo's, so it emits the root steps for a human to run. v1 emitted a `#!/bin/sh` script the human saved + ran with sudo, pinning an explicit subuid range. The PRD simplifies this: emit COPY-PASTE COMMANDS the human pastes into a root shell they enter FIRST (`sudo -i`/`su -`) — no script file (nothing on disk to leak the persona name, nothing to save), and running in a root shell keeps the persona name out of the audit log. And DROP the hard-coded subuid range: `useradd -m` auto-allocates a free block, so N personas never collide.

Goal: change `buildTier2ProvisioningScript` (in `src/anon-pi.ts`) to return the copy-paste command block (become-root line + `useradd -m <account>` + `loginctl enable-linger` + the visudo-validated scoped sudoers install), parameterized by the persona account, password-kept-by-default with opt-in `--nopasswd`, no range line, no chown, no `NETCAGE_GRAPHROOT`. Keep it a PURE string generator, never executed. Update the v1 `hardened-provisioning` tests that assert the old `#!/bin/sh`/range shape to the new shape, in the same green commit.

Test at the pure-generator seam (each pasted command, password default + nopasswd, forbidden-line absence, both default and `anon-<name>` account). "Done" = generator reshaped + tests green under the verify gate, with a changeset committed.

> RECORD non-obvious in-scope decisions (become-root form default `sudo -i` vs `su -`; sudoers file naming per persona) as an ADR if they meet the gate, else a `## Decisions` note. Coordinate the superseding ADR with `persona-adr-and-docs`.
