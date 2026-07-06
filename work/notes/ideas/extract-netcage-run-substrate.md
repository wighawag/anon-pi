---
title: Extract the reusable "run an executable in an isolated, anonymized, per-persona account" substrate from anon-pi
slug: extract-netcage-run-substrate
---

# Extract the reusable netcage-run substrate (seam first, packaging later)

Proposed direction. anon-pi has grown featureful (machines/homes/projects, images, `forward`/`ports`, the hardened dedicated-account deployment, multi-persona with per-persona egress). Most of that is NOT pi-specific: it is a general "run an executable inside a netcage jail, under an isolated + anonymized + per-persona account" substrate. Only a minority layer is genuinely about pi. This note records the direction to draw that seam out, WITHOUT committing yet to where it lands.

## Evidence the substrate is real (not YAGNI)

- **Concept density is ~6:1 generic-to-pi-specific** in `packages/anon-pi/src/` (netcage/machine/proxy/hardened/persona/image/forward concepts vastly outnumber pi-specific ones like models.json seeding, the `llm` `--allow-direct` hole, `~/.pi/agent`, `Dockerfile.pi`/webveil). Most of anon-pi already IS a netcage-orchestration substrate with a thin pi cap.
- **The reuse is ALREADY happening IN-HOUSE, so it is not speculative.** anon-pi already runs things other than a preconfigured pi in the jail: `anon-pi --shell`, the `machine` / `container` verbs, and a hardened persona running ANY command. The "wrap an arbitrary executable" use case is not waiting for a hypothetical second package; anon-pi itself is already multiple consumers of its own generic core. (There is NO concrete external second consumer yet: a web browser was considered but Tor Browser already covers that. So the justification for the SEAM is internal reuse, and a separate PACKAGE is not yet justified.)
- The newest, most compelling-to-reuse machinery (hardened / persona / per-persona egress) is 100% generic: nothing about a dedicated mode-700 account, self-re-exec, or a per-persona Tor circuit is pi-shaped.

## The 3-layer hypothesis

The seam is probably NOT a simple "anon-pi core vs pi-specific" 2-way split. It looks like THREE layers:

1. **netcage** (exists) - the jail + forced egress + the uid-scoped store. A deliberately THIN, single-responsibility drop-in `podman` replacement. Its value is that it is small + auditable ("never weaken forced egress" is trustworthy BECAUSE it is narrow).
2. **A middle "run an executable in an isolated, anonymized, per-persona account" layer** - the reusable substrate this note is about: workspace/home/machine model, image lifecycle, `forward`/`ports`, and the hardened-account + persona + provisioning machinery. Could eventually be a netcage companion, a separate package, or stay inside anon-pi.
3. **anon-pi** - the pi-specific cap on top of (2): `init`'s local-model onboarding (probe endpoint, merge providers, generate `models.json` + settings-seed), the single `llm` `--allow-direct` hole, seeding `~/.pi/agent`, the shipped `Dockerfile.pi`/webveil images.

## Leaning hypothesis for the down/up split (NOT yet decided)

Within the hardened/persona/egress work, the pieces do not all belong on the same layer. The leaning cut (agreed in discussion, still to be validated by the actual refactor):

- **Egress-isolation MECHANISM belongs DOWN in netcage.** Composing a per-identity SOCKS-isolation username (the Tor `IsolateSOCKSAuth` tag) and scoping the store by uid are netcage-native: netcage already owns forced egress and already shipped the uid-scoped store (ADR-0017), and the in-jail login-name leak (Leak 2) is netcage's own concern. "Run this jail as this identity with this isolation tag" is a small, focused capability that fits netcage's narrow remit. Possibly "run as account X" belongs here too.
- **Persona/account POLICY belongs UP in the middle layer.** Which persona exists, its name (`anon-<name>`), provisioning the Unix account (the Tier-2 root commands), the mode-700 workspace/home, the `--as` selection, the interactive onboarding - this is a workspace/identity MANAGER, which would dilute netcage's thin single-responsibility pitch if pushed down into it. It sits above netcage.

So the clean cut is: **netcage grows a small "run as this identity with this isolation tag" primitive; the middle layer owns personas/accounts/workspaces/provisioning on top.** The pi-specific config/onboarding stays in anon-pi (layer 3).

## Recommended first step: draw the seam INTERNALLY, defer packaging

Do NOT extract a package now (speculative reuse + the hardened/persona code is the newest + least-battle-tested; freezing an API around it now would guess its shape wrong). Instead, the low-risk, reversible move:

1. **Refactor WITHIN anon-pi** so the pi-specific parts (layer 3: model seeding, the `llm` field, pi images, the pi bits of `init`) sit behind a clear internal boundary/interface, and the generic core (layer 2) does NOT import them. Untangle the tangles the seam runs through: `config.json`'s `llm` field sits next to the generic `proxy`/`hardened`; `init` interleaves proxy-probing (generic) with model-import (pi). These are config- and flow-level tangles, so the refactor is real work, not just moving files.
2. **Let the seam be DISCOVERED from use, not guessed.** Once the internal boundary is clean, which pieces want to move DOWN into netcage vs OUT into their own package becomes VISIBLE rather than speculative.
3. **The "netcage vs separate package vs stays-in-anon-pi" decision is DOWNSTREAM of the internal refactor**, not a prerequisite. Park it until the seam reveals it.

## Open threads (deferred, resolve when the seam is drawn)

- Does the middle layer become part of netcage, a netcage companion package, its own package, or stay inside anon-pi? (Downstream of step 1.)
- Exact API of a netcage "run as identity + isolation tag" primitive (if the egress mechanism moves down).
- How the pi-specific config/onboarding hooks into a generic core (injectable "seed this file into the home", "probe this local endpoint", "extend the config schema") without the core knowing about pi.
- Whether the middle layer's shape (a library anon-pi imports vs a generic CLI anon-pi drives) matters; note anon-pi already SHELLS OUT to netcage, so a second shell-out layer for orchestration it currently does in-process may be worse than a library.
