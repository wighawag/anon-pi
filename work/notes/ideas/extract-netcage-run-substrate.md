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
2. **A middle "run an executable in an isolated, anonymized, per-persona account" layer** - the reusable substrate this note is about: workspace/home/machine model, image lifecycle, `forward`/`ports`, and the hardened-account + persona + provisioning machinery. It sits ABOVE netcage (composing over netcage's existing CLI; see the corrected down/up section - it needs no netcage change). Could eventually be a separate package or stay inside anon-pi.
3. **anon-pi** - the pi-specific cap on top of (2): `init`'s local-model onboarding (probe endpoint, merge providers, generate `models.json` + settings-seed), the single `llm` `--allow-direct` hole, seeding `~/.pi/agent`, the shipped `Dockerfile.pi`/webveil images.

## The down/up split - CORRECTED: netcage inherits NOTHING new (verified in the netcage source)

An earlier version of this note said the egress-isolation MECHANISM should "go DOWN into netcage" (netcage grows a "run as identity + isolation tag" primitive). Checking the netcage source, that framing is WRONG / misleading: **netcage ALREADY has the entire mechanism. There is nothing to move down.**

- **Store scoping already exists.** `internal/jail/graphroot.go`: the default graphroot is `/var/tmp/netcage-storage-<uid>`, keyed on the RUNNING uid (ADR-0017). So running netcage AS the persona account (`anon-alice`) already gives that account its own non-colliding store, automatically, with zero anon-pi involvement.
- **SOCKS-isolation username already flows end-to-end.** `internal/jail/run.go:335` already forwards the proxy URL's userinfo to the tun2socks redirector: `args = append(args, "-user", cfg.Proxy.Username, "-pass", cfg.Proxy.Password)` (and `internal/cli/cli.go:75` extracts `user:pass` from the proxy URL). So handing netcage `socks5h://anon-alice:x@127.0.0.1:9050` already forwards `anon-alice` as the SOCKS-isolation username to Tor, which isolates the circuit. No netcage change needed.

**So the "mechanism" is entirely a matter of WHAT anon-pi (the middle layer) PASSES to netcage, not new netcage capability:**

- Run netcage AS the persona account (a `sudo -u <account>` decision the middle layer already makes) => store scopes itself (netcage, existing).
- Put the account name in the proxy URL's userinfo (`socks5h://<account>:x@...`, which `persona add` already composes) => circuit isolates itself (netcage forwards it, existing).

Both are middle-layer COMPOSITION decisions over netcage's EXISTING surface. netcage inherits ZERO new code.

Revised layering conclusion:

- **netcage** already provides the COMPLETE egress+store primitive (forced egress, uid-scoped store, proxy-userinfo forwarding). It needs NOTHING added; its narrow, auditable remit is untouched.
- **The middle layer** owns COMPOSING the right netcage invocation (run-as-account, isolation-username-in-URL) PLUS all persona/account/workspace policy (names, `anon-<name>`, Tier-2 provisioning, mode-700 home, `--as`, onboarding). 100% of the new "mechanism" is argument-composition here, not jail capability.
- **anon-pi** keeps the pi-specific cap (layer 3).

**Consequence: there is NO netcage-repo work in this direction, which removes the cross-repo / forced-egress-review concern noted below.** The whole extraction stays in anon-pi's world (a middle layer + a pi cap), composing over netcage's existing CLI exactly as anon-pi already does.

## Recommended first step: draw the seam INTERNALLY, defer packaging

Do NOT extract a package now (speculative reuse + the hardened/persona code is the newest + least-battle-tested; freezing an API around it now would guess its shape wrong). Instead, the low-risk, reversible move:

1. **Refactor WITHIN anon-pi** so the pi-specific parts (layer 3: model seeding, the `llm` field, pi images, the pi bits of `init`) sit behind a clear internal boundary/interface, and the generic core (layer 2) does NOT import them. Untangle the tangles the seam runs through: `config.json`'s `llm` field sits next to the generic `proxy`/`hardened`; `init` interleaves proxy-probing (generic) with model-import (pi). These are config- and flow-level tangles, so the refactor is real work, not just moving files.
2. **Let the seam be DISCOVERED from use, not guessed.** Once the internal boundary is clean, which pieces want to move OUT into their own package (vs stay inside anon-pi) becomes VISIBLE rather than speculative. (netcage is not a candidate destination - see the corrected down/up section: it already has everything, the middle layer is above it.)
3. **The "separate package vs stays-in-anon-pi" decision is DOWNSTREAM of the internal refactor**, not a prerequisite. Park it until the seam reveals it.

## Safety + how tests cover it

The internal-seam-first step (step 1) is designed to be a BEHAVIOUR-PRESERVING refactor: `anon-pi <same verbs> <same flags>` must still produce the same netcage argv, the same on-disk workspace layout, the same exit codes, and the same messages, before and after. The layering is a code-organisation fact, invisible to a user.

**Does it require an external-interface change? NO - and keeping it that way IS the safety constraint.** The seam is INTERNAL (layer 2 vs layer 3 in the code), not at the CLI boundary. So step 1 changes no anon-pi verb/flag/output. An external change is only the OPTIONAL later step of exposing the middle layer as its own CLI (`netcage-run --persona … -- <cmd>`), which is additive and can leave anon-pi's own surface identical (anon-pi becomes an internal consumer of the middle layer). The one caveat: the seam REVEALS surface-level tangles you MAY choose to clean up - e.g. the `llm` config field sits next to the generic `proxy`/`hardened` in `config.json`; moving `llm` behind a pi-namespace would be a user-visible config change needing a migration + changeset. That is a DEFERRABLE choice, not a requirement of the seam; the seam can be drawn with `config.json` untouched.

**How safe (concretely):** the repo already has a strong black-box net - ~320 assertions across ~10 `cli-*.test.ts` files pin the external contract (exit codes, the EXACT netcage argv per verb, the workspace layout, error messages), independent of the 235 internal `anon-pi.ts` exports the seam reorganises. If those CLI tests stay green WITHOUT being edited, the refactor was behaviour-preserving.

**Tests should cover the safety - three specific requirements for the eventual spec/task:**

1. **CLI tests are the behaviour-preserving contract and must pass UNCHANGED.** The done-condition is not just "green gate" but "green gate without editing any `cli-*.test.ts` assertion". An edit forced on a CLI assertion is the signal the external contract moved - surface it, do not silently accept it.
2. **A LAYERING-GUARD test (the one genuinely NEW test the seam demands).** An automated assertion that the generic-core (layer 2) modules do NOT import/reference layer-3 pi-specific symbols (`models.json` / `llm` / `~/.pi/agent` / `Dockerfile.pi` / provider/apiKey). This is what KEEPS the seam drawn - without it, the next feature silently re-tangles the layers and the extraction rots. This guard is the real deliverable of "cover the safety".
3. **A characterisation pin before refactoring.** Audit the highest-value external behaviours the refactor touches (every verb's netcage argv, every exit code, the persona re-exec argv) and confirm each is already asserted; add a golden/characterisation test for any hole FIRST, so the refactor has a fixed point where the existing 320 assertions leave a gap.

## Open threads (deferred, resolve when the seam is drawn)

- Does the middle layer become a separate package or stay inside anon-pi? (Downstream of step 1. NOTE: "part of netcage" is NO LONGER a candidate - netcage already provides everything the mechanism needs, so the middle layer sits ABOVE it, not inside it.)
- How the pi-specific config/onboarding hooks into a generic core (injectable "seed this file into the home", "probe this local endpoint", "extend the config schema") without the core knowing about pi.
- Whether the middle layer's shape (a library anon-pi imports vs a generic CLI anon-pi drives) matters; note anon-pi already SHELLS OUT to netcage, so a second shell-out layer for orchestration it currently does in-process may be worse than a library.
