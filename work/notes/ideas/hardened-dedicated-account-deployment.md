---
title: Hardened deployment under a dedicated Unix account (out of a host agent's casual reach)
slug: hardened-dedicated-account-deployment
---

# Hardened deployment under a dedicated Unix account

Proposed idea. Run anon-pi's whole workspace under a **dedicated Unix account** (`netuser`) so that a coding agent running on the host **as your normal login user** cannot *accidentally* surface your anonymized work.

## Threat model: accidental discovery, not a determined attacker

The adversary is not malicious and not trying to break out. It is **you being too casual with your own host agent**: you ask a host coding agent (running as your login user) "find my previous conversation about X" or "where's that work folder", and it dutifully `grep`s / `find`s your `$HOME` and stumbles onto your anonymized recon work in `~/.anon-pi/machines/*/home/.pi/agent/sessions/`. In an AI-driven project the session transcript basically *is* the work, and surfacing it re-associates "anonymized" activity with you.

Key clarifications that shape the design (settled in discussion):

- The in-jail anon-pi agent is **not** the concern here (it is confined; it cannot reach the host store regardless). The concern is a **different** agent loose on the host as your login user.
- This is a **discoverability boundary**, not hard containment. Your login user *can* `sudo -u netuser` (with a password) if it deliberately chooses to. That is accepted: the point is that a "find my old work" request never *does* that. The sudo password is a **feature** here, it makes crossing the boundary a deliberate act, not something an over-eager agent trips into.
- Therefore we do NOT need the "narrow launch-only gateway / no interactive shell as netuser" complexity that defeating a *malicious* agent would require. A normal `sudo -u netuser anon-pi ...` with all verbs intact is fine.

The defense is plain Unix DAC: `netuser` owns the workspace mode-700, your login user is not in it, so a casual `find`/`grep` as you simply cannot read those files.

Caveat to state loudly in any docs: this defends against an **unprivileged** host process/agent running as your login user. A host agent with root (or blanket passwordless sudo) defeats it entirely (root ignores DAC). If your host agents run with broad sudo, this buys little.

## What must move under netuser (all three, or the boundary leaks)

1. `~netuser/.anon-pi` (homes + projects + config). anon-pi already supports this via `ANON_PI_HOME`. Easy.
2. **netcage's graphroot.** Today netcage writes container scratch/overlay to the shared, world-visible `/var/tmp/netcage-storage`, so a host `find /var/tmp` can surface metadata/scratch. It must move to a `netuser`-private mode-700 path. This depends on netcage promoting `NETCAGE_GRAPHROOT` (or equivalent) to a supported knob. **BLOCKED-ON** the netcage idea `private-graphroot-for-dedicated-account`.
3. runroot / transient podman state (`$XDG_RUNTIME_DIR`): under a lingering dedicated account this is already `netuser`-owned; verify nothing spills world-visible.

## The idea: anon-pi actively helps, in two tiers

"Actively help" must respect that account provisioning needs **root**, which anon-pi (a rootless npm-installed launcher) must never grab silently.

- **Tier 1 (rootless, anon-pi does it directly):** everything on anon-pi's side of the boundary once the account exists. Set `ANON_PI_HOME` into `netuser`'s tree, set the private `NETCAGE_GRAPHROOT`, write a small `anon` convenience wrapper (`exec sudo -u netuser <path>/anon-pi "$@"`), `chmod 700` the workspace, and run a **preflight** that *checks* the account is set up correctly (subuid/subgid ranges present, `loginctl enable-linger` on, `/dev/net/tun` accessible, graphroot path private) and prints exactly what is missing.
- **Tier 2 (needs root, anon-pi GENERATES but does not EXECUTE):** the account provisioning. anon-pi emits a **ready-to-run, reviewable script** (`useradd`, `/etc/subuid` + `/etc/subgid` lines, `loginctl enable-linger netuser`, the scoped sudoers snippet) and tells you to review + run it with sudo yourself. It never silently sudo's. This keeps anon-pi installable without trusting it with root.

Recommended shape: keep the sudo **password** (do NOT ship a `NOPASSWD` sudoers rule by default), the password is what makes crossing deliberate. A tiny `anon` wrapper gives the convenience (sudo caches the password ~15 min), so day-to-day it is `anon recon` and one password prompt, while the host agent's "find my work" never types it.

## Composes with

- The `--ephemeral` idea (a run that saves nothing at all): belt-and-suspenders. Ephemeral = nothing to find; dedicated account = what you *do* keep is out of casual reach.
- The netcage forensic tier (tmpfs-backed graphroot): stronger still, but a separate concern.

## Open threads

- Exact preflight checks and their remediation messages (subuid ranges, linger, tun, graphroot mode).
- Wrapper install location and name (`anon`), and how it coexists with a normal (non-hardened) install on the same machine.
- Should `init` grow an `--hardened` path, or should this be a separate `anon-pi harden` verb? (A verb keeps the common `init` path simple.)
- Docs must state the unprivileged-host-agent assumption plainly (root/sudo-blanket defeats it).
