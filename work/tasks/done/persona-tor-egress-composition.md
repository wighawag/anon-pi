---
title: Tor detection + per-persona proxy URL composition (pure + probe seam)
slug: persona-tor-egress-composition
prd: multi-persona-hardened-accounts
blockedBy: [persona-name-mapping-and-selection]
covers: [2, 3, 4]
---

## What to build

The PURE composition of a persona's fail-closed egress, plus the injected Tor-detection seam, per PRD decisions 3 + 4 + 5. Each persona gets ONE socks5h endpoint; two ways to obtain one.

- **Tor multi-persona URL composer (pure).** Given a persona account (`anon-<name>`) and a Tor SOCKS host:port (default `127.0.0.1:9050`), compose the literal proxy URL `socks5h://<account>:x@<host:port>`, injecting the ACCOUNT NAME as the SOCKS-isolation username (Tor's `IsolateSOCKSAuth`, on by default, gives each distinct SOCKS username its own circuit/exit). The password is an ignored placeholder (`x`). This literal URL is what `persona add` stores in the persona's own `config.json` `proxy` field (decision 5) — composed ONCE at creation, then read as an ordinary v1 `proxy`. Pure: account + host:port injected.
- **Tor detection (injected probe).** A predicate "is a Tor SOCKS proxy running at host:port?" as an INJECTED seam (reuse init's existing SOCKS probe / `netcage detect-proxy` shape — the impure probe lives in cli.ts). `persona add` uses it to OFFER the Tor path when detected. Pure logic decides "offer Tor?" over the injected probe result.
- **Fail-closed per persona (pure).** A persona whose resolved egress is absent must yield the same fail-closed refusal as v1 (`PROXY_REQUIRED_MESSAGE`), never a fallback to another persona's proxy or to none. This is mostly reuse of v1's `resolveProxy` fail-closed path, now per-persona (the persona's own config supplies the proxy). Assert the fail-closed behaviour holds per persona.

Do NOT change netcage's forced-egress: this only composes WHICH socks5h URL a persona uses; netcage still forces exactly one per launch, fail-closed. No `NETCAGE_GRAPHROOT`. Keep the composer + offer-logic pure; the Tor probe is the injected seam.

## Acceptance criteria

- [ ] The Tor URL composer produces `socks5h://<account>:x@<host:port>` for the given persona account (account as the SOCKS-isolation username), default host:port `127.0.0.1:9050`, as a pure function.
- [ ] The Tor-detection is an INJECTED probe seam; a pure "offer Tor?" predicate decides over its result (no real socket/`netcage` call in the pure layer).
- [ ] Fail-closed per persona: a persona with no resolvable proxy refuses byte-identically to v1's `PROXY_REQUIRED_MESSAGE`; never falls back to another persona's proxy or to no proxy.
- [ ] The composed URL is a plain literal stored in the ordinary `proxy` field (no schema marker, no launch-time re-derivation) — consistent with the config-in-persona-home decision.
- [ ] Tests cover the composer (account -> URL, custom host:port), the offer-Tor predicate (detected/not), and the per-persona fail-closed path; pure, no real Tor/socket/netcage.
- [ ] Every change produces a changeset; the `verify` gate passes.

## Blocked by

- `persona-name-mapping-and-selection` — the persona account (`anon-<name>`) the URL is composed for.

## Prompt

> FIRST, check this task against current reality (launch snapshot; may have drifted): confirm v1's proxy handling (`resolveProxy`, `PROXY_REQUIRED_MESSAGE`, the socks5h URL shape) and init's existing SOCKS/`netcage detect-proxy` probe are still as this task assumes, and that the mapping task landed the persona account. Build on what landed; route real drift to needs-attention.

You are adding per-persona egress to anon-pi's multi-persona hardened deployment (prd `multi-persona-hardened-accounts`). Domain (see `CONTEXT.md`): the proxy is the socks5h endpoint that forces + anonymizes egress, REQUIRED and never guessed (fail-closed). v1 had ONE global proxy; multi-persona gives EACH persona its own, so two personas never share an exit IP (the isolation that matters most). Two ways to get a per-persona endpoint: (1) Tor multi-persona — reuse a single running Tor, but hand it the persona's ACCOUNT NAME as the SOCKS-isolation username (`socks5h://<account>:x@127.0.0.1:9050`), and Tor's `IsolateSOCKSAuth` gives each persona its own circuit/exit for free; (2) bring-your-own socks5h endpoint. This task lands the PURE Tor-URL composer, the injected Tor-detection seam + offer-logic, and the per-persona fail-closed guarantee.

Goal: in `src/anon-pi.ts`, add a pure composer that builds `socks5h://<account>:x@<host:port>` (account as isolation username, default `:9050`), a pure "offer Tor?" predicate over an INJECTED Tor-detection probe (the real probe reuses init's SOCKS/`netcage detect-proxy` seam, wired later), and assert fail-closed-per-persona reuses v1's `PROXY_REQUIRED_MESSAGE` (no fallback across personas). Do NOT weaken netcage's forced egress (still one forced socks5h per launch; this only picks which). No `NETCAGE_GRAPHROOT`.

Test at the pure seam: composer output, offer-Tor over injected probe, per-persona fail-closed. "Done" = pure egress composition + tests green under the verify gate, with a changeset committed.

> RECORD non-obvious in-scope decisions (the placeholder password char; default Tor host:port) as an ADR if they meet the gate, else a `## Decisions` note. Coordinate the superseding ADR with `persona-adr-and-docs`.
