---
title: `anon-pi persona add <name>` verb — provision a persona (impure wiring)
slug: persona-add-verb-wiring
prd: multi-persona-hardened-accounts
blockedBy: [persona-tier2-commands-generator, persona-tor-egress-composition]
covers: [1, 3, 4, 5, 7, 11]
---

## What to build

The `anon-pi persona add <name>` verb: the thin impure wiring that provisions a persona using the pure pieces from the sibling tasks. Dispatched like the other nouns in `cli.ts` (`args[0] === 'persona'` -> `runPersona`, mirroring `runMachine`/`runImage`/`runContainer`).

`persona add <name>`:

- Maps the bare `<name>` to the account `anon-<name>` (pure mapper); `persona add` with no name provisions/refers to the default `anon`. Validate the name (pure), error clearly on invalid.
- **Chooses egress:** probe for a running Tor (the injected detection seam). If detected, OFFER Tor multi-persona and, on accept, compose `socks5h://anon-<name>:x@<host:port>` (pure composer). Otherwise prompt for a bring-your-own socks5h endpoint, and PRINT the one-line uniqueness WARNING (decision 6: this endpoint must be unique to the persona; two personas on one BYO endpoint share an exit; prefer Tor). anon-pi stores NO used-endpoint list.
- **Tier 1 (rootless):** create the persona's workspace under its tree with `ANON_PI_HOME` pointed there + `chmod 700`, and write the persona's own `config.json` carrying the composed/entered `proxy` (the ordinary v1 config, in the persona's home). NOTE: writing into `~anon-<name>/` needs the account to exist first (Tier 2), so sequence correctly — the resumable "run the root commands, then continue" pattern from v1's init step applies here too (re-probe the account, then do the in-home Tier-1 write once it exists).
- **Tier 2 (root):** PRINT the copy-paste commands (the reshaped generator) for the human to paste into a root shell they enter first. anon-pi never runs them.
- Idempotent/re-runnable (re-adding an existing persona re-checks + is a no-op where already done).

Persona IDENTITY (email/git/creds) is explicitly NOT set up here — that is the user's job inside the persona home (out of scope).

Isolate all writes in tests (temp homes; the persona home write must target a temp dir, and the real `~anon-*`/`~/.anon-pi` must be asserted untouched). No real sudo/su/useradd/loginctl/Tor.

## Acceptance criteria

- [ ] `anon-pi persona add <name>` is dispatched in `cli.ts` (a `persona` noun, mirroring `machine`/`image`/`container`), maps `<name>` -> `anon-<name>`, and errors clearly on an invalid name.
- [ ] Egress selection: Tor OFFERED when the injected probe detects it (compose `socks5h://anon-<name>:x@…`); else prompt BYO socks5h + print the uniqueness warning. No used-endpoint list is stored.
- [ ] Tier 1 writes the persona's own `config.json` (ordinary v1 shape) with the persona `proxy`, into the persona's tree at mode 700; Tier 2 PRINTS the copy-paste root commands (no script file). Resumable across account creation (re-probe then continue), mirroring v1's init step.
- [ ] Persona identity (email/git) is NOT configured (out of scope); the verb only provisions account + workspace + egress.
- [ ] Idempotent: re-running `persona add <name>` for an existing, fully-provisioned persona is a no-op / re-check, not a failure or a duplicate.
- [ ] Tests isolate every write (temp persona home + temp `ANON_PI_HOME`), assert the real `~anon-*` / `~/.anon-pi` are UNTOUCHED, and run no real sudo/su/useradd/loginctl/Tor/podman. TTY-gated like the existing interactive verbs.
- [ ] Every change produces a changeset; the `verify` gate passes.

## Blocked by

- `persona-tier2-commands-generator` — the copy-paste root commands this verb prints.
- `persona-tor-egress-composition` — the Tor URL composer + detection + fail-closed egress this verb wires.

## Prompt

> FIRST, check this task against current reality (launch snapshot; may have drifted): confirm the two dependency tasks landed (the reshaped copy-paste Tier-2 generator; the Tor composer + injected detection + fail-closed), and that `cli.ts`'s noun-dispatch (`runMachine`/`runImage`/`runContainer`) + v1's resumable init hardening loop + `resolveAnonPiHome`/`readJsonConfig`/config write helpers are as assumed. Build on what landed; route real drift to needs-attention.

You are adding the `anon-pi persona add <name>` verb to anon-pi's multi-persona hardened deployment (prd `multi-persona-hardened-accounts`). Domain (see `CONTEXT.md`): a persona is a dedicated `anon-<name>` account with its own mode-700 home + its own fail-closed egress; `persona add` provisions one. It runs the same two-tier flow as v1's init hardening (Tier 1 rootless, Tier 2 a human-run root step), now per-persona and with egress selection: offer Tor multi-persona if a Tor is detected (compose `socks5h://anon-<name>:x@…`), else take a BYO socks5h endpoint (with a uniqueness warning; no stored used-endpoint list). Tier 2 is PRINTED copy-paste commands the human pastes into a root shell entered first — anon-pi never runs them. Persona identity (email/git) is OUT of scope (configured in-home). Never silently sudo; never weaken forced egress.

Goal: wire the `persona` noun + `add <name>` in `cli.ts` (mirror `runMachine`), using the pure mapper/composer/generator from siblings, the injected Tor probe, and the persona's own `config.json` write into its tree (mode 700). Reuse v1's resumable "print root step, re-probe, continue" loop for the account-creation sequencing. Keep the impure layer THIN.

Test with isolation: temp persona home + temp `ANON_PI_HOME`, assert the real `~anon-*`/`~/.anon-pi` untouched, no real sudo/su/useradd/loginctl/Tor. "Done" = the verb provisions a persona end-to-end (Tier-1 in-home config write + Tier-2 printed commands + egress choice) with isolated tests green under the verify gate, and a changeset committed.

> RECORD non-obvious in-scope decisions (persona-add sub-verb surface; how re-run idempotency is detected; the BYO-warning exact text) as an ADR if they meet the gate, else a `## Decisions` note. Coordinate the superseding ADR with `persona-adr-and-docs`.
