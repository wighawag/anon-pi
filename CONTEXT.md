# CONTEXT — anon-pi domain language

The domain glossary for `anon-pi`. Agents and skills use THIS vocabulary when naming modules, tests, and discussing the system. Architectural rationale lives in `docs/adr/` (decisions); product framing lives in `work/prds/`.

## What anon-pi is

anon-pi launches the pi coding agent inside a **netcage** jail: all web/DNS egress is forced through a socks5h proxy (fail-closed, anonymized), with one direct hole for a local model. It manages **machines** (an image + a persistent host home) and **projects** (work folders), so a user runs pi in reusable, anonymized, jailed environments. It is a thin host-side launcher for netcage; netcage owns the jail.

## Core domain terms

- **netcage** — the sibling tool anon-pi drives: a drop-in `podman` replacement that forces all container egress through a socks5h proxy, fail-closed. anon-pi composes `netcage run`/`start`/verb argv; netcage owns the jail (netns, firewall, DNS). anon-pi never touches podman directly.
- **machine** — an **image + a persistent host home** (`$HOME`: shell config, pi config + extensions, and pi conversations). A named, durable, anonymized workstation. Machines own their image; a project needing a different image runs on a different machine.
- **home** — a machine's persistent `$HOME` directory on the HOST (`machines/<M>/home`), bind-mounted into the jail at `/root`. Holds config, extensions, and `~/.pi/agent/sessions/` (conversations). The durable, inspectable store: the container itself is disposable.
- **project** — a work folder under the **projects root**, mounted into the jail at `/projects/<name>` (pi's cwd). Just files, image-agnostic; pi keys a conversation by its launch cwd, so `/projects/<name>` is the conversation key.
- **projects root** — the host directory that becomes `/projects` in the jail. GLOBAL by default (`~/.anon-pi/projects/`, shared across machines), configurable via `config.json`/`ANON_PI_PROJECTS`, per-launch override via `--mount`.
- **proxy** — the socks5h endpoint that anonymizes all egress; REQUIRED and never guessed (fail-closed). Set by `anon-pi init` / config, overridable by `ANON_PI_PROXY`.
- **socks5h** — SOCKS5 with remote (proxy-side) DNS resolution, so hostnames never leak to the host resolver. netcage requires `socks5h://`.
- **forced-egress / jail** — netcage's invariant: a jailed container's TCP egress is always forced through the proxy, fail-closed; anon-pi never weakens it.
- **local model / direct hole** — the one non-proxied path: an RFC1918/link-local `host:port` (`ANON_PI_LLM`) reached via netcage's `--allow-direct`, so pi can call a LAN model. Everything else stays proxied.
- **`anon` account** — the single dedicated Unix account a **hardened deployment** runs the whole anon-pi workspace under (canonical name `anon`, not per-persona; supersedes the old idea note's drifted `netuser`). Its home is mode-700, the login user is not in it, so a casual host `find`/`grep` cannot read the session transcripts. anon-pi runs netcage as this account too, so netcage's uid-scoped store lands in the account's own path (netcage ADR-0017); anon-pi sets no `NETCAGE_GRAPHROOT`. See `docs/adr/0006`.
- **hardened deployment / DAC discoverability boundary** — the deployment mode where anon-pi's workspace lives under the dedicated **`anon` account** behind plain Unix DAC (mode-700 home). It is a DISCOVERABILITY boundary against an UNPRIVILEGED host agent running as your login user (accidental `find`/`grep` discovery), NOT hard containment: a host agent with root or blanket passwordless sudo defeats it (documented, not defended). Crossing is DELIBERATE, gated by a kept sudo password (no `NOPASSWD` by default). See prd `hardened-dedicated-account-deployment`, `docs/adr/0006`.
- **self-re-exec** — how a **hardened** anon-pi enters the **`anon` account**: it is its OWN wrapper (no separate `anon` wrapper file). On a hardened install a login-user invocation always redirects (option A; only a caller already `anon` skips it, the loop guard) by SPAWNING `sudo -u anon -i <anon-pi> "$@"` (login `-i` form; `su - anon -c '…'` is the documented fallback). anon-pi never sets a uid and ships no setuid binary: it only spawns `sudo`/`su`. See `docs/adr/0006`.
- **promptGuidance** — the per-repo NUDGE namespace in `.dorfl.json` whose members (currently just `testFirst`) strengthen the wording in the worker's in-band prompt. NOT a gate: the `verify` step is still the only acceptance bar. Omitted ⇒ off; absence is the default.
- **work/ contract** — the on-disk system this repo uses, defined by the reference docs in **`work/protocol/`** (copied here by `setup`): `WORK-CONTRACT.md` (the contract), `CLAIM-PROTOCOL.md`, `REVIEW-PROTOCOL.md`, `task-template.md`, `prd-template.md`, `ADR-FORMAT.md`. Three REGIME umbrellas — `notes/` (capture buckets), `tasks/` (the build board), `prds/` (the prd lifecycle) — plus top-level `questions/` and `protocol/`. One markdown file per item, status = the folder it lives in (never a field). Capture buckets: `notes/ideas/` (proposed), `notes/observations/` (spotted, unverified, append-only), `notes/findings/` (verified external/domain ground truth, each with a `source:`). ADRs (`docs/adr/`, format in `work/protocol/ADR-FORMAT.md`) record what WE decided and why.

## Conventions

Standing per-change rules agents must follow in this repo.

- **Every change requires a changeset** (`pnpm changeset`). This is enforced: the `.dorfl.json` `verify` gate runs `pnpm changeset status --since=main`, so a change branch with no changeset fails the gate. See `AGENTS.md`.

## Skills this repo uses

- Required: `setup` (onboarding/migration), `to-prd`, `to-task`.
- Recommended: `review`, `grill-me`.
