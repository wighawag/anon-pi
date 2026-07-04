---
title: CLI init onboarding — proxy detect+verify, llm capture, image pick, write config
slug: cli-init-onboarding
prd: machines-and-projects-workspace
blockedBy: [workspace-layout-and-config, models-json-generation-from-llm, cli-launch-surface-grammar-a, cli-data-verbs-delete-home-project]
covers: [17]
---

## What to build

`anon-pi init`: the re-runnable onboarding that captures the proxy, the local
model endpoint, and the default machine image, then writes `config.json` + the
default machine. Replaces `import`.

In `src/cli.ts` (with any pure detection/decision helpers in `src/anon-pi.ts`):

1. **Proxy**: probe common SOCKS ports (9050 Tor, 9150 Tor Browser, 1080
   wireproxy/generic), CONFIRM each is really SOCKS5 via a minimal handshake,
   present findings to CHOOSE (or enter `host:port`). Weak process hints only
   ("a `tor` process is running → likely Tor"). **NEVER claim/label the exit
   provider** (a SOCKS proxy does not announce Mullvad/Proton; a false label is a
   dangerous lie for an anonymity tool). VERIFY with `netcage verify --proxy
   socks5h://<chosen>` and show the real EXIT IP as evidence (proof it is not the
   host IP). User confirms on evidence.
2. **Local model endpoint**: ask for `host:port`, probe reachability, and generate
   the `models.json` provider from it (using the pure generator) — this replaces
   `import`.
3. **Default machine image**: menu from shipped Dockerfiles ([1] basic pi, [2] pi
   + webveil/searxng, [3] existing image ref, [4] skip); building runs `podman
   build`.
4. Write `config.json` (`{ proxy, llm, defaultMachine }`) and create the `default`
   machine. Re-runnable: shows current values pre-filled; NEVER destroys
   machines/homes.

Keep the detection/verify DECISIONS pure where possible (the SOCKS5 handshake
result interpretation, the findings-without-labels formatting) so they are
testable; the actual socket probes, `netcage verify` spawn, `podman build`, and
prompts are the thin impure I/O.

## Acceptance criteria

- [ ] `anon-pi init` probes SOCKS ports, confirms SOCKS5 via a handshake, presents
      findings, and lets the user choose or enter `host:port`.
- [ ] Proxy detection presents EVIDENCE (ports, handshake result, `netcage
      verify` exit IP) and WEAK process hints only — it NEVER claims/labels the
      exit provider. A test asserts no provider label is ever emitted.
- [ ] `netcage verify --proxy socks5h://<chosen>` is invoked and the exit IP shown
      before the user confirms.
- [ ] The llm endpoint is captured + probed and `models.json` is generated from it
      (via the pure generator); `import` is gone.
- [ ] The image menu offers the shipped Dockerfiles / existing ref / skip and
      builds via `podman build` when chosen.
- [ ] `config.json` + the `default` machine are written; re-running shows current
      values and never destroys machines/homes.
- [ ] Tests cover the pure detection/decision helpers (handshake interpretation,
      findings-without-labels, config write shape); the socket/`netcage
      verify`/`podman build`/prompt I/O stays thin. Mirror existing test style.
- [ ] Every change produces a changeset; the `verify` gate passes.
- [ ] Tests ISOLATE the config write to a temp anon-pi home and assert the real
      `~/.anon-pi/config.json` is untouched; no real network probe hits a real
      proxy in unit tests (inject the probe/verify results).

## Blocked by

- `workspace-layout-and-config` (the `config.json` shape + layout it writes).
- `models-json-generation-from-llm` (generates the provider from the endpoint).
- `cli-launch-surface-grammar-a` (the base launch path in the shared `src/cli.ts`).
- `cli-data-verbs-delete-home-project` (the PRECEDING `cli-*` task in the
  `src/cli.ts` chain: the `cli-*` tasks all edit `src/cli.ts`, so they are chained
  one-after-another to avoid parallel same-file conflicts; build on its version).

## Prompt

> FIRST, check this task against current reality: confirm the config layout, the
> pure models.json generator, and the launch surface landed. If the `config.json`
> shape or generator signature differs, adapt or route to needs-attention.

`anon-pi init` onboards a user honestly: it captures the socks5h **proxy**, the
local-model endpoint, and the default machine image, then writes `config.json` +
the `default` machine. It REPLACES the old `import`. The load-bearing HONESTY
constraint (this is an anonymity tool): proxy detection presents EVIDENCE only
(open ports, a real SOCKS5 handshake, a real `netcage verify` exit IP) and weak
process hints — it MUST NEVER claim/label the exit provider (a SOCKS proxy does
not announce Mullvad/Proton; a false label would be a dangerous lie).

Goal: land `anon-pi init` in `src/cli.ts` (with pure detection/decision helpers in
`src/anon-pi.ts`). Flow: probe SOCKS ports + confirm SOCKS5 handshake + present
findings (no provider labels) + `netcage verify --proxy socks5h://<chosen>` +
show exit IP + confirm; capture + probe the llm endpoint and generate models.json
from it (pure generator); image menu from shipped Dockerfiles / existing ref /
skip, building with `podman build`; write `config.json` + the `default` machine.
Re-runnable, pre-filling current values, never destroying homes.

Keep the DECISIONS pure + tested (handshake interpretation, the
findings-without-labels formatter — assert it never emits a provider name); the
socket probes, `netcage verify`/`podman build` spawns, and prompts are thin I/O.
"Done" = `init` working end-to-end (with injected probe/verify results in tests),
tests green under `verify`, with a changeset. Edits `src/cli.ts` after
`cli-launch-surface-grammar-a` (serialized).

> RECORD non-obvious in-scope decisions (probe port set, hint wording) as an ADR
> if they meet the gate, else a `## Decisions` note. The never-label-the-provider
> rule is a hard requirement, not a decision to revisit.
