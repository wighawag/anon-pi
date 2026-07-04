# anon-pi

Run [pi](https://github.com/earendil-works/pi-mono) on anonymized, jailed **machines**: all of pi's web and DNS egress is forced through a socks5h proxy (fail-closed, leak-proof) by [netcage](https://github.com/wighawag/netcage), while ONE direct hole is opened to a local model on your LAN. Your machines and their conversations live in a browsable host workspace (`~/.anon-pi/`); the container itself is disposable.

anon-pi is a thin, opinionated launcher over `netcage run`. It is a separate package on purpose: netcage wraps any tool and stays tool-agnostic; anon-pi holds the pi-specific opinion. netcage owns the jail (network namespaces, firewall, DNS); anon-pi never touches Podman directly and never weakens the forced-egress invariant.

> **Upgrading from 0.4.0?** The model changed: a bare positional is now a
> **project**, not a host path, and `import` / `--fresh` / `--ephemeral` are
> gone. See [Migrating from 0.4.0](#migrating-from-040).

## The model: machines + projects

- A **machine** is an **image + a persistent host home**. The home (`machines/<name>/home`) is bind-mounted into the jail at `/root`, so it holds your shell config, pi config + extensions, and your pi conversations. A machine is a named, durable, anonymized workstation. The container is disposable; the home survives.
- A **project** is a work folder under the **projects root**, mounted into the jail at `/projects/<name>` (pi's cwd). It is just files, image-agnostic. Because pi keys a conversation by its launch cwd, `/projects/<name>` is the conversation key: the same project used from two machines has a separate conversation in each machine's home.
- The **projects root** is global by default (`~/.anon-pi/projects/`, shared across machines). Override it per-launch with `--mount <host-parent>`, or persistently via `config.json` / `ANON_PI_PROJECTS`.
- The **proxy** is a `socks5h://` endpoint that anonymizes all egress. It is REQUIRED and never guessed: no proxy, no launch (fail-closed).
- The **local model** is the one non-proxied path: an RFC1918/link-local `host:port` reached directly, so pi can call a LAN model while everything else stays proxied.

## Requirements

- **Linux.** anon-pi inherits netcage's platform reality (network namespaces + nftables + rootless Podman). See [Platform](#platform).
- **[`netcage`](https://github.com/wighawag/netcage)** on your `PATH`.
- A running **socks5h proxy** (local Tor, `ssh -D`, wireproxy, ...).
- A **container image with `pi` on its `PATH`**. `anon-pi init` can build one for you from a shipped `Dockerfile.pi`; see [Providing a pi image](#providing-a-pi-image).

## Install

```sh
npm i -g anon-pi
# or run without installing:
npx anon-pi
```

## Quick start

```sh
anon-pi init          # one-time: verify your proxy, capture your local model, pick/build an image
anon-pi               # bare: pick a project (or a shell, or a new project) from the menu
anon-pi recon         # or launch straight into a project
```

The **first time** you launch anon-pi with no config yet, it welcomes you and runs `init` automatically before launching (so you never hit a bare "set `ANON_PI_PROXY`" wall on day one). You can also run `anon-pi init` yourself any time to reconfigure. (If you drive config purely by env — you export `ANON_PI_PROXY` yourself — the auto-onboarding is skipped.)

`init` is interactive and re-runnable. It:

1. **Proxy** — probes common SOCKS ports, confirms SOCKS5 with a real handshake, shows the findings (evidence only, it never labels the exit provider), then runs `netcage verify` and shows the real EXIT IP as proof it is not your host IP. You confirm on that evidence.
2. **Local model** — captures the `host:port` of your model, probes it, then **imports models**. It merges two sources, both scoped to that endpoint: the provider in your own `~/.pi/agent/models.json` whose URL matches it (marked `[configured]` — your hand-tuned entries, with their `contextWindow`/`maxTokens`/etc.), and the endpoint's live `/v1/models` (marked `[server]`). You pick which to import (Enter/`c` = all configured, `a` = all, numbers, or `s` = skip) and which is the **default**. Because only the provider served by this endpoint (the one `--allow-direct` hole) is read, no other provider — and no other key — can ever enter the seed. It writes a **global** `models.json` + settings seed (shared by every machine, since the `llm` endpoint is global) and updates any already-seeded machine homes in place (conversations untouched). If the matching provider carries a real-looking apiKey, init **refuses** (it would put a host credential into the anon home) unless you pass `--force-allow-local-llm-api-key`.
3. **Image** — pick a shipped `Dockerfile` (built via `podman build`), an existing image ref, or skip.
4. **Projects root** — the host folder mounted at `/projects` (where bare `anon-pi` looks for projects). Defaults to `~/.anon-pi/projects/`; point it at your own dev folder if you want to jail pi into files you edit with host tools (`--mount <parent>` still overrides it per-launch).

It then writes `~/.anon-pi/config.json` + the `default` machine. It **never destroys** an existing home; it pre-fills your current values and only adds/updates config + the default machine.

## Usage

```
anon-pi                        MENU: pick a project (pi), a shell, or a new project
anon-pi <project>              pi in the project (/projects/<project>); exit pi -> host
anon-pi <project> <pi-args…>   forward args to pi (e.g. -p for a headless one-shot)
anon-pi --session <id>         resume a pi session by id (forwarded to pi; no project needed)
anon-pi --continue             continue your most recent pi session (also -r/--resume, --fork)
anon-pi --list-models          list the models pi sees (also --models; no project needed)
anon-pi pi <pi-args…>          run pi with ANY args and no project (the passthrough)
anon-pi --version              print anon-pi's version (also -V)
anon-pi --shell [<project>]    a jailed bash (at ~, or cd'd into <project>) - the project-hopper
anon-pi -m <machine> [<p>]     the same, on <machine> (its own image + home + conversations)
anon-pi --mount <parent> [<p>] root at a HOST parent folder instead of the projects root
anon-pi init                   onboard: verify your proxy, capture your local model, pick an image
anon-pi machine …              manage machines (create / list / set-image / rm)
anon-pi --delete-home [<m>]    delete a machine's home (config + convos); keep its image pin + files
anon-pi --delete-project <p>   delete a project's files + its per-machine sessions; keep the homes
```

A `<project>` is a folder under the projects root (mounted at `/projects`; pi's cwd). The token `.` means the root itself (a scratch pi at `/projects`, at `/work` under `--mount`, or at `~` for a shell). A named project is created on the host if it does not exist yet.

Every subcommand carries its own help: `anon-pi --help` (the launch surface), `anon-pi init --help`, and `anon-pi machine --help`.

### Common tasks

| I want to… | Command |
| --- | --- |
| Set up (first time / reconfigure) | `anon-pi init` |
| Just pick something to work on | `anon-pi` (the menu) |
| Work in a project | `anon-pi <project>` |
| Resume a project's conversation | `anon-pi <project>` (same machine + project ⇒ same session) |
| Resume a specific session by id | `anon-pi --session <id>` (or `anon-pi --continue` for the latest) |
| Run a one-shot prompt (scriptable) | `anon-pi <project> -p "…"` |
| Hop between projects / poke the box | `anon-pi --shell` then `cd /projects/<p> && pi` |
| A scratch pi not tied to a subfolder | `anon-pi .` |
| Use a separate anonymized environment | `anon-pi -m <machine> <project>` |
| Jail pi into a host folder you edit with host tools | `anon-pi --mount <host-parent> <subfolder>` |
| Install system tools and keep them | `anon-pi --keep --shell` (then `apt install …`) |
| Add a second machine | `anon-pi machine create <name> --image <ref>` |
| Reset a machine's conversations | `anon-pi --delete-home [<machine>]` |
| Delete a project (files + its sessions) | `anon-pi --delete-project <project>` |

### A first session, end to end

```sh
anon-pi init                       # verify proxy (see the real exit IP), capture your model, build an image
anon-pi recon                      # creates ~/.anon-pi/projects/recon, launches pi there
# … work in pi; exit pi returns you to your host shell …
anon-pi recon                      # later: same project, same machine ⇒ your conversation resumes
anon-pi --shell                    # sit on the machine: cd /projects/recon && pi, run tmux, etc.
```

Nothing you care about lives in the container: your conversation, config, and files are all in `~/.anon-pi/`, so the throwaway container going away on exit loses nothing.

### The bare menu

Run `anon-pi` with no project and you get an interactive, arrow-key menu (up/down or `k`/`j` to move, Enter to select, Ctrl-C to quit). It lists the projects under the active root and marks which the current machine has already worked on ("used" vs "new here"), plus a `.` here entry, a shell entry, and a "new project" entry. Picking a project launches it **byte-for-byte identically** to typing the equivalent command. `-m <machine>` and `--mount <parent>` with no project also open the menu (scoped to that machine / root).

The menu needs a TTY. Without one it refuses and tells you to name a project directly (`anon-pi <project>`).

### `--shell`: the project-hopper

pi cannot `cd` into a different project mid-session (a conversation is keyed to its launch cwd). So when you want to move between projects, or poke around the machine, use a jailed shell:

```sh
anon-pi --shell            # bash at ~ (the machine home), inside the jail
anon-pi --shell recon      # bash cd'd into /projects/recon
```

From inside the shell you can `cd` between `/projects/*` and run `pi` yourself in whichever one you want. The shell forwards no arguments (`anon-pi --shell recon extra` is an error); run pi from inside it instead. Same forced-egress jail as a pi launch.

### Headless / one-shot

Any tokens after the project are forwarded to pi verbatim. A run is headless (no TTY needed, so it fits scripts and pipes) only when you forward pi's `-p`/`--print`; other forwarded flags (like `--session`) stay interactive.

```sh
anon-pi recon -p "summarize the findings in ./notes"
```

### Resuming a session

`anon-pi <project>` already resumes that project's conversation (the session is keyed by its `/projects/<name>` cwd, so same machine + same project reopens it). To resume a **specific** session, forward pi's session flags — with no project needed, because pi finds the session by id and switches to its own project:

```sh
anon-pi --session <id>     # resume that exact session
anon-pi --continue         # continue your most recent session (also -r/--resume, --fork <id>)
anon-pi -m webveil --session <id>   # on a specific machine
```

So when pi prints `To resume this session: pi --session <id>` on exit, just prefix it: `anon-pi --session <id>`.

### Running pi directly (`anon-pi pi …`)

Any tokens **after a project** are already forwarded to pi (`anon-pi recon --model qwen -p "…"`). For pi commands that need **no project** — listing models, exporting a session, any other pi flag — use the passthrough:

```sh
anon-pi --list-models              # what models does pi see in the jail? (also --models)
anon-pi pi --model qwen3-coder     # run pi with arbitrary flags, no project
anon-pi pi --export out.html --session <id>   # export a session and exit
anon-pi -m webveil pi --version    # pi's own version, on a machine
```

`anon-pi pi <args…>` is the general escape hatch: it runs pi inside the jail with exactly the args you give and no project, so you never need anon-pi to special-case each pi flag. (`--version`/`-V` on its own prints *anon-pi's* version; use `anon-pi pi --version` for pi's.)

### `--mount`: root at a host parent (the caveat)

`--mount <parent>` re-roots this launch at a HOST parent folder instead of the projects root: the parent is mounted at `/work`, and a `<project>` positional then names a subfolder under it (`/work/<project>`).

The caveat: `<parent>` is a **host parent directory**, not a single project path. anon-pi mounts the parent and treats the positional as a name under it; it does not mount an arbitrary host folder as the project itself. Use `--mount` when you want a whole host tree available at `/work` (for example your real code checkout's parent), and pick the subfolder as the project.

### Kept vs throwaway (`--rm` / `--keep`)

The container is **throwaway by default** (`--rm`): it is deleted the moment pi exits. Your machine home and project files persist regardless (they are host mounts); only the container's own scratch filesystem is discarded.

Pass `--keep` for an exploratory flow where the container's filesystem should survive across exits (for example you `apt install` something, quit, and re-enter the same container):

```sh
anon-pi --keep recon       # keep this container; re-entering resumes it
```

anon-pi finds a kept container by netcage's managed label and `netcage start`s it on re-entry. `--keep` and `--rm` together is an error (pick one; `--rm` is the default).

## Managing machines

```
anon-pi machine create <name> [--image <ref>]   create a machine, pin its image
anon-pi machine list                            list machines and their images
anon-pi machine set-image <name> <ref>          re-pin the image (WARNS; no reseed)
anon-pi machine rm <name> [--yes]               delete the machine + its home
```

A machine's home is seeded on FIRST LAUNCH, not at create. `set-image` re-pins the image only and **warns**: it does not reseed or touch the home, so the home's extensions were built for the old image. `rm` confirms on a TTY, skips the prompt with `--yes`, and aborts non-interactively without it (it never deletes unprompted in a script). `create` with no `--image` and no TTY is an error (a machine needs an image to launch).

If you never create a machine explicitly, launches use the `default` machine (which `init` creates). Give a machine its own image + home + conversations by naming it with `-m`.

## Deleting data

The destructive verbs replace the old `--fresh`. Each confirms on a TTY, skips with `--yes`, and aborts non-interactively without it.

- `anon-pi --delete-home [<machine>]` deletes ONE machine's home (its config, conversations, shell env), but **keeps its image pin** (relaunch to seed a fresh home) and **keeps all project files** (they live under the projects root, not in the home). The machine defaults to `config.defaultMachine` (else `default`) when omitted.
- `anon-pi --delete-project <project>` deletes that project's files (its folder under the projects root) AND that project's per-machine session dir in every machine home. The machine homes are otherwise kept. The project name is required.

## Environment

Environment variables are **overrides**: env wins over `config.json`, which wins over a machine's `machine.json`, which wins over the built-in defaults.

| Var | Required | Default | Meaning |
| --- | --- | --- | --- |
| `ANON_PI_PROXY` | yes | (none) | the socks5h proxy URL (Tor/wireproxy/`ssh -D`). No default: it is what anonymizes, so it is never guessed (fail-closed). |
| `ANON_PI_LLM` | yes | (none) | RFC1918/link-local `IP[:port]` of the local model (the one direct hole). |
| `ANON_PI_IMAGE` | fallback | (none) | container image with `pi` on `PATH`, used when a machine has no image pinned. |
| `ANON_PI_HOME` | no | `~/.anon-pi` | the anon-pi workspace dir (holds `config.json`, `machines/`, `projects/`). NOT under `~/.config`. |
| `ANON_PI_PROJECTS` | no | `<ANON_PI_HOME>/projects` | projects-root override (the host dir mounted at `/projects`). |

`config.json` (written by `init`) holds the persistent `proxy`, `llm`, `defaultMachine`, and optional `projects` root; a machine's `machine.json` holds its pinned `image` and optional per-machine `projects` override. Env vars override all of these per-launch.

## Forced egress: honesty by evidence

anon-pi does not tell you "you are anonymous". It composes a launch that **forces** every bit of pi's TCP egress through your `socks5h://` proxy (fail-closed, DNS resolved proxy-side so hostnames never hit your host resolver), with exactly one direct hole to your local model. That is the invariant netcage enforces; anon-pi never strips or adds an egress flag.

For proof, it shows you **evidence**, never a label: `init` (and `netcage verify`) run a real request through the proxy and print the actual EXIT IP, so you can see it is not your host IP. It deliberately **never claims which exit provider** you are using (Tor, a VPN, an SSH tunnel): it can only observe the exit, not name the network behind it. A running `tor`/`wireproxy` process is surfaced as a WEAK local hint, clearly not a claim about the exit.

## Layout on disk

Everything anon-pi keeps lives under `~/.anon-pi/` (override with `ANON_PI_HOME`):

```
~/.anon-pi/
  config.json                proxy, llm, defaultMachine, (optional) projects root
  models.json                the GLOBAL local-model seed (shared by every machine)
  settings-seed.json         the GLOBAL default-model selection seed
  machines/
    default/
      machine.json           pinned image, (optional) per-machine projects override
      home/                  the persistent $HOME bind-mounted at /root
        .pi/agent/           pi config, extensions, sessions (your conversations)
      models.json            OPTIONAL per-machine override of the global seed
  projects/                  the default global projects root (mounted at /projects)
    recon/
    ...
```

**The local-model seed is GLOBAL.** Because `config.json` holds one `llm` endpoint (the single `--allow-direct` hole, shared by every machine), the `models.json` describing it lives once at the workspace root and seeds **every** machine's fresh home. `anon-pi init` writes it there (and updates any already-seeded machine homes in place, without touching conversations). A machine that needs a *different* local model can override it with its own `machines/<M>/models.json`.

The home is the durable, inspectable store. On a FRESH machine home, the image's staged defaults (`/opt/anon-pi-seed/agent`) and the resolved `models.json` seed (per-machine override if present, else the global one) are promoted in once and a marker is stamped; after that pi owns the home and your changes (added models, installed extensions) are never clobbered.

## Providing a pi image

anon-pi does not ship or default an image: a machine points at an image that has the `pi` CLI on its `PATH`. pi's maintainers do not publish an official prebuilt image, so the reputable path is to **build a small one from the upstream-documented recipe** (which installs the official [`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) npm package, no third-party image to trust).

`anon-pi init` can build it for you: pick the shipped `Dockerfile.pi` and it runs `podman build` and pins the result. You can also build it yourself:

```sh
# from wherever this package's Dockerfile.pi is (e.g. node_modules/anon-pi)
podman build -t localhost/anon-pi-pi:latest -f Dockerfile.pi .
export ANON_PI_IMAGE=localhost/anon-pi-pi:latest
# or pin it to a machine:
anon-pi machine set-image default localhost/anon-pi-pi:latest
```

The image only needs `pi` reachable on `PATH`. anon-pi bind-mounts the machine home over the container's `/root` and seeds a fresh home from the image's staging dir, so the image needs **no `ENTRYPOINT` and no config volume**.

A community image also exists ([`gni/pi-coding-agent-container`](https://github.com/gni/pi-coding-agent-container)); it is third-party and unvetted, so review it yourself before trusting it with your (anonymized) credentials.

### Extensions, skills, and their services go in the image

anon-pi deliberately seeds **only your local model** (the `models.json` provider for the one `--allow-direct` endpoint, plus the default-model selection) — never your extensions or skills, and never any other provider from your config. That is on purpose: your extension set is an identity fingerprint, extensions run code and can leak, and many need a runtime that a copied folder cannot carry (for example `pi-webveil` needs a running SearXNG). The right home for capabilities is the **image**, installed once, reviewably, into the STAGING dir so anon-pi promotes them into a fresh machine home:

```dockerfile
FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      bash ca-certificates git ripgrep && rm -rf /var/lib/apt/lists/*
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent

ENV ANON_PI_STAGE=/opt/anon-pi-seed/agent
RUN mkdir -p "$ANON_PI_STAGE"
# Trust the two cwd roots so pi never prompts on the mounted project:
RUN printf '{"/projects": true, "/work": true}\n' > "$ANON_PI_STAGE/trust.json"

# Extensions are installed with `pi install` into the STAGING dir (recorded
# there, promoted into the fresh home), NOT a global npm install:
#   RUN PI_CODING_AGENT_DIR="$ANON_PI_STAGE" pi install npm:pi-webveil
# ...and an extension that needs a service (pi-webveil -> SearXNG) also installs
# and configures that service in the image. Its egress is forced through the
# socks proxy by netcage at runtime, so it must be happy with proxy-only,
# DNS-through-proxy networking.

WORKDIR /projects
```

Install image defaults into the **staging dir** (`PI_CODING_AGENT_DIR=/opt/anon-pi-seed/agent pi install ...`), NOT `~/.pi/agent`: anon-pi mounts the persistent home over `/root` (so `~/.pi/agent` is the mount) and promotes the staging dir into it on a fresh launch. Anything you then `pi install` *inside* a session also persists (it is written to the mounted home). See the shipped `Dockerfile.pi` comments for the exact form.

A worked example ships in this package: [`examples/Dockerfile.pi-webveil`](examples/Dockerfile.pi-webveil) builds pi + the `pi-webveil` extension (staged) + a local SearXNG. Note the anonymity subtlety it documents: SearXNG's own crawl is anonymized here **because netcage forces every process's egress through the proxy**, so webveil's plain `egress: direct` is correct in-jail (the usual "local SearXNG leaks your IP" caveat does not apply).

## Trusting the project

pi treats a mounted project as untrusted until approved. The shipped Dockerfiles stage a `trust.json` trusting `/projects` and `/work` (in `/opt/anon-pi-seed/agent`), which is promoted into the machine home on first launch, so you are not prompted. You can also approve once inside a session; it persists in the home.

## Migrating from 0.4.0

anon-pi 0.4.0 was a **per-workdir** launcher: a bare positional was a host folder mounted at `/work`, session state lived per-workdir under `~/.config/anon-pi/state/<slug>/`, and you seeded it with `anon-pi import`. That model is gone. What changed:

- **A bare positional is now a PROJECT, not a host path.** `anon-pi ./recon` no longer mounts host `./recon`; it means the project `recon` under the projects root (`/projects/recon`). To make a host folder available, use `--mount <host-parent>` (mounted at `/work`) and select the subfolder as the project.
- **`anon-pi import` is GONE.** Onboarding is now `anon-pi init`, which (among other things) generates the local-model `models.json` for the default machine. There is no separate import step.
- **`--fresh` is GONE.** To reset, use the explicit data verbs: `anon-pi --delete-home [<machine>]` (wipe a machine's home, keep its image pin + project files) and `anon-pi --delete-project <project>` (wipe a project's files + its per-machine sessions).
- **`--ephemeral` / `ANON_PI_EPHEMERAL` are GONE.** The container is **throwaway by default** now (`--rm`); use `--keep` when you want it to survive across exits. There is no separate ephemeral mode.
- **The layout moved.** Everything now lives under `~/.anon-pi/` (`config.json` + `machines/` + `projects/`), **not** under `~/.config/anon-pi`. `ANON_PI_HOME` still overrides the root; the old `ANON_PI_CONFIG` / `ANON_PI_SOURCE_MODELS` variables are gone.
- **Old state is NOT migrated.** anon-pi does not read or convert your old `~/.config/anon-pi/state/<slug>/` directories. Once you have moved to the new model you can delete the old tree:

  ```sh
  rm -rf ~/.config/anon-pi        # old 0.4.0 state; nothing new reads it
  ```

Start fresh with `anon-pi init`, then `anon-pi` (the menu) or `anon-pi <project>`.

## Troubleshooting

- **`netcage not found on PATH`** — anon-pi is a launcher for [netcage](https://github.com/wighawag/netcage); install netcage first (Linux only).
- **`set ANON_PI_PROXY …` (fail-closed)** — no proxy is configured. Run `anon-pi init` to detect + verify one, or export `ANON_PI_PROXY=socks5h://<host:port>`. There is deliberately no default: the proxy is what anonymizes, so it is never guessed.
- **A launch says the machine has no image** — pin one: `anon-pi machine set-image default <ref>`, or export `ANON_PI_IMAGE=<ref>`, or re-run `anon-pi init` and pick/build a `Dockerfile`. See [Providing a pi image](#providing-a-pi-image).
- **`no TTY` on a bare `anon-pi`** — the menu and interactive pi need a terminal. In a script, name the project and forward args: `anon-pi <project> <pi-args…>` (that path needs no TTY).
- **The exit IP looks like your home IP** — the proxy is not actually anonymizing. Re-run `anon-pi init`; its `netcage verify` step prints the real exit IP as proof. anon-pi never claims a provider, only shows you the exit.
- **A destructive verb won't run in a script** — `machine rm` / `--delete-home` / `--delete-project` confirm on a TTY and abort non-interactively; pass `--yes` to proceed unattended.
- **`--keep` re-entry started a fresh container** — a kept container is matched by its `(machine, projects-root, project)` identity; changing any of those (a different `-m`, a different `--mount` parent, a different project) is a different launch and gets its own container.

## Platform

anon-pi is **Linux-only**, because netcage's jail is built on Linux kernel primitives (network namespaces, nftables, `/dev/net/tun`, rootless Podman + pasta). There is no native macOS/Windows jail.

On macOS/Windows, Podman runs inside a Linux VM (`podman machine`), so netcage (and anon-pi) can run **inside that VM**. Two caveats matter for anon-pi:

- **`--allow-direct` to a LAN model is VM-boundary-sensitive.** "Directly over the LAN" means the *VM's* NIC, not your Mac/Windows host LAN, so a model at an RFC1918 address on the host network may not be directly reachable from inside the VM the way it is on bare Linux.
- **Host-loopback proxy reachback** (`ssh -D`/Tor on the host's `127.0.0.1`) is the host loopback, not the VM's.

Treat non-Linux as best-effort-via-VM, not supported.

## License

[AGPL-3.0-only](./LICENSE)
