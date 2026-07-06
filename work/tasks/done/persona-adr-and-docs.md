---
title: Superseding ADR + multi-persona docs (per-persona egress, --as, persona add)
slug: persona-adr-and-docs
prd: multi-persona-hardened-accounts
blockedBy: [persona-as-launch-selection-wiring]
covers: [2, 5, 10, 11]
---

## What to build

The durable decision record + user-facing docs for multi-persona, written once the feature exists (so they match what shipped).

- **A new ADR that SUPERSEDES / extends ADR-0006** (`docs/adr/0007-multi-persona-hardened-accounts.md`, per numbering). Record the durable decisions: N persona accounts `anon-<name>` with `anon` the default (uniform "persona #0", no special-casing); `ANON_ACCOUNT` is now the DEFAULT not the only account; per-persona fail-closed egress (Tor multi-persona via the account-name SOCKS-isolation username, or BYO socks5h); persona config = the ordinary `config.json` in the persona's own mode-700 home (proxy stored literally there — not a leak, behind the DAC wall); selection via `--as <name>` (name-in-argv accepted; the typed-prompt history-hygiene variant deferred to an idea); Tier-2 = copy-paste commands run in a root shell first, no script file, subid auto-allocated by `useradd`; the generalized "am I the target persona?" loop guard. Mark ADR-0006's single-account decision as SUPERSEDED (a Status/Supersedes note on 0007 pointing at 0006, and ideally a superseded-by note added to 0006). Record the considered options (why prefix `anon-<name>`; why copy-paste vs script file; why store the proxy literally).
- **Update `CONTEXT.md`** so the vocabulary reflects personas: a **persona** = a dedicated `anon-<name>` account (+ its home/history/store/egress); the default persona `anon`; per-persona egress. Extend the existing v1 hardened glossary entries rather than contradicting them.
- **Update the README hardened section** for multi-persona: creating a persona (`anon-pi persona add <name>`, Tor-offered or BYO egress, copy-paste root commands run in a root shell first), using one (`anon-pi --as <name>`, default `anon`), and the per-persona egress + isolation story. Keep the loud discoverability caveat (unprivileged host agent only; root defeats it) and ADD the honesty caveat that persona NAMES are unavoidably in system files (passwd/sudoers/home path) — hiding them defends the audit/history trail, not root forensics. Note persona identity (email/git) is the user's job in-home.

## Acceptance criteria

- [ ] `docs/adr/0007-multi-persona-hardened-accounts.md` records the durable multi-persona decisions and explicitly SUPERSEDES ADR-0006's single-account decision (with a cross-reference; a superseded-by note on 0006).
- [ ] `CONTEXT.md` defines a persona (`anon-<name>` account, default `anon`, per-persona egress), extending the v1 hardened entries coherently.
- [ ] The README hardened section documents `persona add <name>` (Tor/BYO egress, copy-paste root commands in a root shell first, no script file), `--as <name>` selection (default `anon`), and per-persona egress/isolation.
- [ ] Docs keep the unprivileged-only caveat AND add the persona-names-in-system-files honesty caveat (defends audit/history, not root forensics). Persona identity is out of scope (in-home).
- [ ] Docs do NOT claim hard containment, and match what actually shipped (read the merged sibling tasks, not this snapshot).
- [ ] Every change produces a changeset; the `verify` gate passes (`format:check` covers docs).

## Blocked by

- `persona-as-launch-selection-wiring` — the full feature (provision + select + launch) must exist and be settled before it is documented, so the docs match reality.

## Prompt

> FIRST, check this task against current reality (launch snapshot; may have drifted): read how the sibling multi-persona tasks ACTUALLY landed (their done records + the code + ADR-0006) and document THAT. If the shipped shape differs from this snapshot, document the shipped shape and note the drift.

You are writing the ADR + docs for anon-pi's multi-persona hardened deployment (prd `multi-persona-hardened-accounts`), which SUPERSEDES the single-`anon`-account v1 (ADR-0006). Domain (see `CONTEXT.md`): a persona is a dedicated `anon-<name>` account (default `anon`) with its own mode-700 home + its own fail-closed egress (Tor multi-persona via the account-name SOCKS-isolation username, or BYO socks5h). Provision with `anon-pi persona add <name>` (copy-paste root commands run in a root shell first, no script file, subid auto-allocated); use with `anon-pi --as <name>` (default `anon`). It is a discoverability + network-unlinkability boundary against an UNPRIVILEGED host agent; root defeats the on-host half. Persona names are unavoidably in system files — hiding them defends the audit/history trail, not root forensics. Persona identity (email/git) is the user's concern in-home.

Goal: write `docs/adr/0007-multi-persona-hardened-accounts.md` (superseding ADR-0006, with cross-references), extend `CONTEXT.md` with the persona vocabulary, and update the README hardened section for `persona add`/`--as`/per-persona egress with the honest caveats. Document what SHIPPED (read the merged siblings), not this snapshot.

"Done" = ADR + CONTEXT.md + README updated, matching the implemented feature, verify gate green (format:check included), with a changeset committed.

> RECORD any material doc/ADR framing decision briefly in the done record.
