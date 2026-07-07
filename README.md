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

1. **Hardened deployment** — asks FIRST whether to run anon-pi's whole workspace under a dedicated `anonpi` account (see the hardened-deployment section below). This has **no default**: you answer `y` or `n` explicitly. It is first on purpose: it is the most likely step to block (it needs a system-wide anon-pi + netcage and a provisioned account), so you find out before investing in the proxy/model/image steps, and every later step is hardened-aware from the start. If you say yes it runs the preflight and prints only the root commands still needed.
2. **Proxy** — probes common SOCKS ports, confirms SOCKS5 with a real handshake, shows the findings (evidence only, it never labels the exit provider), then runs `netcage verify` and shows the real EXIT IP as proof it is not your host IP. You confirm on that evidence. (When your netcage has `detect-proxy`, init reuses netcage's own scanner for this; otherwise it probes locally.)
3. **Local model** — captures the `host:port` of your model, probes it, then **imports models**. It merges two sources, both scoped to that endpoint: the provider in your own `~/.pi/agent/models.json` whose URL matches it (marked `[configured]` — your hand-tuned entries, with their `contextWindow`/`maxTokens`/etc.), and the endpoint's live `/v1/models` (marked `[server]`). You pick which to import (Enter/`c` = all configured, `a` = all, numbers, or `s` = skip) and which is the **default**. Because only the provider served by this endpoint (the one `--allow-direct` hole) is read, no other provider — and no other key — can ever enter the seed. It writes a **global** `models.json` + settings seed (shared by every machine, since the `llm` endpoint is global) and updates any already-seeded machine homes in place (conversations untouched). If the matching provider carries a real-looking apiKey, init **refuses** (it would put a host credential into the anon home) unless you pass `--force-allow-local-llm-api-key`.
4. **Image** — pick a shipped `Dockerfile` (built via `podman build`), an existing image ref, or skip. If the shipped tag (`localhost/anon-pi/pi[-webveil]:latest`) is already in netcage's store, init offers to REUSE it instead of rebuilding, so re-running `init` (e.g. after an anon-pi upgrade) does not silently re-trigger the multi-minute build; answer `n` to rebuild fresh. On a **hardened** install the exists-check and the build run **as the `anonpi` account**, so the image lands in *that account's* uid-scoped netcage store (`/var/tmp/netcage-storage-<uid>`) where the hardened jail actually reads it — not stranded in your login user's store. (Each account has its own store by design, so a hardened persona builds its own copy; there is no shared image store, that isolation is what keeps personas unlinkable on-host.)
5. **Projects root** — the host folder mounted at `/projects` (where bare `anon-pi` looks for projects). Defaults to `~/.anon-pi/projects/`; point it at your own dev folder if you want to jail pi into files you edit with host tools (`--mount <parent>` still overrides it per-launch). On a **hardened** install the default lives under the `anonpi` account's tree, and a path under your login home is **refused**: it would leak your login username (through the mount source and file ownership) into the anon-run jail, defeating the dedicated account.

It then writes `~/.anon-pi/config.json` + the `default` machine. It **never destroys** an existing home; it pre-fills your current values and only adds/updates config + the default machine.

## Usage

```
anon-pi                        MENU: pick a project (pi), a shell, or a new project
anon-pi <project>              pi in the project (/projects/<project>); exit pi -> host
anon-pi <project> <pi-args…>   forward args to pi (e.g. -p for a headless one-shot)
anon-pi <pi-args…>             any leading pi flag with no project forwards to pi
                               (e.g. `anon-pi -p "hello world"`, `anon-pi --model x`)
anon-pi --session <id>         resume a pi session by id, in its own project (also -r/--resume)
anon-pi <project> --fork <id>  fork a session into <project> (`.`=root; --continue too; project required)
anon-pi --list-models          list the models pi sees (also --models; no project needed)
anon-pi pi <pi-args…>          explicit passthrough: run pi with ANY args and no project
anon-pi --version              print anon-pi's version (also -V)
anon-pi --shell [<project>]    a jailed bash (at ~, or cd'd into <project>) - the project-hopper
anon-pi forward [<p>] [--port …]  open a host port onto a running container's in-jail server
anon-pi ports [<project>]      list a running container's open in-jail TCP listeners
anon-pi -m <machine> [<p>]     the same, on <machine> (its own image + home + conversations)
anon-pi --mount <parent> [<p>] root at a HOST parent folder instead of the projects root
anon-pi init                   onboard: verify your proxy, capture your local model, pick an image
anon-pi machine …              manage machines (create / list / set-image / rm)
anon-pi image …                snapshot a running container into an image; list anon-pi images
anon-pi --delete-home [<m>]    delete a machine's home (config + convos); keep its image pin + files
anon-pi --delete-project <p>   delete a project's files + its per-machine sessions; keep the homes
```

A `<project>` is a folder under the projects root (mounted at `/projects`; pi's cwd). The token `.` means the root itself (a scratch pi at `/projects`, at `/work` under `--mount`, or at `~` for a shell). A named project is created on the host if it does not exist yet.

Every subcommand carries its own help: `anon-pi --help` (the launch surface), `anon-pi init --help`, `anon-pi machine --help`, and `anon-pi image --help`.

### Common tasks

| I want to… | Command |
| --- | --- |
| Set up (first time / reconfigure) | `anon-pi init` |
| Just pick something to work on | `anon-pi` (the menu) |
| Work in a project | `anon-pi <project>` |
| Resume a project's conversation | `anon-pi <project>` (same machine + project ⇒ same session) |
| Resume a specific session by id | `anon-pi --session <id>` (resumes in its own project) |
| Fork a session into a project | `anon-pi <project> --fork <id>` (`.` for the root; created on demand) |
| Run a one-shot prompt (scriptable) | `anon-pi <project> -p "…"` |
| Hop between projects / poke the box | `anon-pi --shell` then `cd /projects/<p> && pi` |
| Open an in-jail server on the host | `anon-pi forward <project> --port 3001` (or `8080:3001`) |
| See a container's open in-jail ports | `anon-pi ports <project>` |
| A scratch pi not tied to a subfolder | `anon-pi .` |
| Use a separate anonymized environment | `anon-pi -m <machine> <project>` |
| Jail pi into a host folder you edit with host tools | `anon-pi --mount <host-parent> <subfolder>` |
| Install system tools and keep them | `anon-pi --shell` (then `apt install …`), then `anon-pi image snapshot <name>` while it is still running |
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
anon-pi --shell            # bash at /projects (the projects root), inside the jail
anon-pi --shell .          # same as bare --shell: bash at /projects (`.` is a synonym)
anon-pi --shell recon      # bash cd'd into /projects/recon
```

A bare `--shell` lands at the projects root (`/projects`, or `/work` under `--mount`), the project-hopper's natural home: the model is project-centric, and anything you write under the machine home (`~`) persists into that machine's config home on the host, which is for config, not work. From inside the shell you can `cd` between `/projects/*` and run `pi` yourself in whichever one you want; `cd ~` reaches the machine home for the rare case you want it. The shell forwards no arguments (`anon-pi --shell recon extra` is an error); run pi from inside it instead. Same forced-egress jail as a pi launch.

### Reaching an in-jail server from the host (`forward` / `ports`)

A jailed tool sometimes runs a server you want to open on the host: a dev/preview server on `:3001`, a local API. The jail deliberately publishes no ports (that would open an inbound path around the forced egress), so host access is a separate, explicit verb, the way `kubectl port-forward` / `ssh -L` work. anon-pi wraps netcage's `forward` so you never handle the raw container name (needs **netcage >= 0.10.0**: anon-pi reads managed containers back via `netcage ps --format json`):

```sh
# terminal 1: a running session with a server inside (e.g. pi started `pnpm dev` on :3001)
anon-pi recon
# terminal 2: open that port on your host
anon-pi forward recon --port 3001        # host 127.0.0.1:3001 -> jail 3001, until Ctrl-C
```

The port is host-first, like docker/kubectl, so you can bind it on a **different host port**:

```sh
anon-pi forward recon --port 8080:3001   # host 8080 -> jail 3001
anon-pi forward recon --port 3001 --bind 0.0.0.0   # LAN-visible (netcage warns; loopback is the default)
```

The positional is always the **project** (a numeric name like `3001` is a project, never a port), and it only **filters** which containers are offered. If several sessions match (you can run `anon-pi recon` in two terminals), anon-pi shows a picker, each row annotated with that container's open in-jail ports.

**Don't know the port?** Omit `--port` and anon-pi lists the container's open listeners and prompts you (defaulting to the obvious one), then asks whether to expose it on a different host port. You can also just list them:

```sh
anon-pi ports recon      # the container's open in-jail TCP listeners
```

`ports` reads the jail's listeners **image-independently** (netcage reads `/proc/net/tcp*` via the sidecar), so it works even for a minimal image with no `ss`/`netstat`/`nc`. An explicit `--port` may name a port that **isn't open yet**: the forward binds the host side immediately and reaches into the jail on the first connection, so you can set it up before the server starts. Forwarding works for as long as the container is running (every launch is throwaway, so the window is the session's lifetime).

### Headless / one-shot

Any tokens after the project are forwarded to pi verbatim. A run is headless (no TTY needed, so it fits scripts and pipes) only when you forward pi's `-p`/`--print`; other forwarded flags (like `--session`) stay interactive.

```sh
anon-pi recon -p "summarize the findings in ./notes"
```

#### Streaming the agent's progress

A plain `-p` prints only pi's final answer, so a long run looks frozen while the agent works. Add anon-pi's `--mode text-stream` to watch it live: anon-pi runs pi with `--mode json` inside the jail, parses that event stream on the host, and renders a readable per-turn view (each assistant message, plus a `▶ <tool>` line per tool call) to **stderr**, while pi's final answer still goes to **stdout** so the run stays pipeable.

```sh
anon-pi recon -p --mode text-stream "summarize the findings in ./notes"
anon-pi recon -p --mode text-stream "..." 2>/dev/null   # answer only (stderr is the progress view)
```

`text-stream` is an anon-pi-owned mode value: it requires `-p`, and it cannot be combined with another `--mode` (anon-pi owns the mode to drive the stream).

### Resuming a session

`anon-pi <project>` already resumes that project's conversation (the session is keyed by its `/projects/<name>` cwd, so same machine + same project reopens it). To resume a **specific** session by id, forward pi's `--session`/`--resume` flag with no project: anon-pi looks the session up in the machine's store, reads the project (cwd) it belongs to, and launches pi **there**, so it resumes in place instead of asking to fork:

```sh
anon-pi --session <id>     # resume that exact session, in its own project
anon-pi --resume <id>      # same (also -r)
anon-pi -m webveil --session <id>   # on a specific machine
```

So when pi prints `To resume this session: pi --session <id>` on exit, just prefix it: `anon-pi --session <id>`.

**Forking / continuing needs a project.** `--fork <id>` writes a *new* session and `--continue`/`-c` resumes the *newest* session for a cwd, so with no project they would land a conversation in the projects root by surprise. anon-pi refuses them without a project and asks you to name one (`.` for the root; the folder is created on demand):

```sh
anon-pi newproj --fork <id>   # fork <id> into a fresh /projects/newproj
anon-pi . --fork <id>         # fork into the root itself
anon-pi recon --continue      # continue recon's most recent session
```

If you name a project that differs from the session's own (e.g. `anon-pi other --session <id>`), anon-pi trusts you and cds into `other`; pi then asks whether to fork the session into it (its normal guard for a cwd mismatch).

### Running pi directly

Any tokens **after a project** are forwarded to pi (`anon-pi recon --model qwen -p "…"`). For pi commands that need **no project**, any leading pi flag anon-pi does not own is forwarded to pi automatically, so you can just type it:

```sh
anon-pi -p "hello world"            # a headless one-shot, no project
anon-pi --model qwen3-coder         # run pi with arbitrary flags, no project
anon-pi --list-models              # what models does pi see in the jail? (also --models)
anon-pi pi --export out.html --session <id>   # explicit `pi` passthrough (equivalent, clearer)
anon-pi -m webveil pi --version    # pi's own version, on a machine
```

anon-pi consumes its OWN flags (`-m`/`--machine`, `--shell`, `--mount`, `-i`/`--image`) and hands **everything else** to pi (pi rejects a genuinely bogus flag itself), so you never need anon-pi to special-case each pi flag. The explicit `anon-pi pi <args…>` spelling still works and reads clearly when you want it. (`--version`/`-V` on its own prints *anon-pi's* version; use `anon-pi pi --version` for pi's.)

### `--mount`: root at a host parent (the caveat)

`--mount <parent>` re-roots this launch at a HOST parent folder instead of the projects root: the parent is mounted at `/work`, and a `<project>` positional then names a subfolder under it (`/work/<project>`).

The caveat: `<parent>` is a **host parent directory**, not a single project path. anon-pi mounts the parent and treats the positional as a name under it; it does not mount an arbitrary host folder as the project itself. Use `--mount` when you want a whole host tree available at `/work` (for example your real code checkout's parent), and pick the subfolder as the project.

### Throwaway always; persist with a snapshot image

Every launch is **throwaway**: the container is removed the moment pi (or the shell) exits. Your machine home and project files persist regardless (they are host mounts); only the container's own scratch filesystem is discarded. There is no flag to change this: `--keep` and `--rm` are **gone** (see [Migrating](#migrating-from-040)).

To preserve system state you set up in a session (for example after you `apt install` something), **snapshot the still-running container into a named image** and pin a machine to it, giving you a real, named, immutable environment instead of a murky mutable pet container:

```sh
anon-pi --shell recon                 # a jailed shell; apt install / configure as you like
# in another terminal, while that session is STILL running:
anon-pi image snapshot toolbox        # freeze the running container -> anon-pi/toolbox:latest
anon-pi machine create box --image anon-pi/toolbox:latest   # a machine pinned to it
anon-pi -m box recon                  # later: launch on the snapshot-pinned machine
```

The catch is timing: the snapshot commits a **running** container, so do it before you exit (once the session ends, the throwaway container is already gone). What you actually care about, your pi config and conversations, is in the machine home and survives every exit anyway.

One step does both: `anon-pi image snapshot toolbox --create-machine box` commits the image AND creates machine `box` from it, carrying the source machine's home + conversations over (the same prompts described under [Managing images](#managing-images)). `anon-pi image list` shows your snapshots with their provenance (source machine, source image, when), including orphaned snapshots (an overwritten `:latest`) by their ID.

## Managing machines

```
anon-pi machine create <name> [--image <ref>]   create a machine, pin its image
anon-pi machine list                            list machines and their images
anon-pi machine set-image <name> <ref>          re-pin the image (WARNS; no reseed)
anon-pi machine rm <name> [--yes]               delete the machine + its home
```

A machine's home is seeded on FIRST LAUNCH, not at create. `set-image` re-pins the image only and **warns**: it does not reseed or touch the home, so the home's extensions were built for the old image. `rm` confirms on a TTY, skips the prompt with `--yes`, and aborts non-interactively without it (it never deletes unprompted in a script). `create` with no `--image` and no TTY is an error (a machine needs an image to launch).

`create --image <ref>` is **provenance-aware**: if `<ref>` was produced by `anon-pi image snapshot` (it carries an `anon-pi.source-machine` label) and that machine's home still exists, you are offered its home + conversations to carry over (opt-in; with no TTY nothing is copied). Otherwise it is a plain fresh create.

If you never create a machine explicitly, launches use the `default` machine (which `init` creates). Give a machine its own image + home + conversations by naming it with `-m`.

## Managing images

```
anon-pi image snapshot <name> [-m <machine>] [--create-machine <m>|--update-machine <m>]
                                 commit the RUNNING container into anon-pi/<name>:latest
anon-pi image list               list anon-pi images with their provenance (read-only)
```

`image snapshot` captures the current filesystem of a **running** jailed container (for example after you `sudo apt install` some tools) into the clean tag `anon-pi/<name>:latest`, baking **provenance** as podman labels (source machine, source image, snapshot time). This is the way to keep container-level system changes (every launch is throwaway): freeze the running box into a named image, then pin a machine to it. The container is auto-detected from your running anon-pi containers (a picker when several are up); `-m <machine>` is an **optional filter**, not a required source. The container must still be running (do not exit the session; podman pauses it briefly during the commit). A same-name re-snapshot **overwrites** the `:latest` tag; the previous image becomes dangling but keeps its provenance, so `image list` still shows it by ID. To preserve a specific snapshot, snapshot it under a different name.

`--create-machine <m>` also creates a **new** machine `<m>` pinned to the fresh snapshot, **copying the source machine's home** (your pi config, extensions, and dotfiles, which are correct for the committed image) **minus its conversations**. Conversations are handled separately: you are offered each one **grouped by project**, opt-in per project (default **skip**), choosing **copy** or **skip** for each (with no TTY, none are copied). Copy never touches the source machine; after copying, a single confirmed step (default No) can **delete** the copied groups from the source (the only way to "move" a conversation out). This is equivalent to `image snapshot` followed by a provenance-aware `machine create --image`.

`--update-machine <m>` instead **re-pins an existing** machine `<m>` to the fresh snapshot (equivalent to `image snapshot` followed by `machine set-image`). The home is left untouched; when `<m>` is the snapshot's own source machine the home already matches the new image, so no warning is printed (unlike `set-image`). The two flags are mutually exclusive: `--create-machine` refuses an existing name, `--update-machine` refuses a missing one.

`image list` reads the provenance labels straight off the images (**zero stored state**): it shows every `anon-pi/*` image plus any dangling image still carrying an `anon-pi.source-machine` label (an orphaned snapshot), by its ID.

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

## Hardened deployment: keep your work out of a host agent's casual reach

Your anonymized work (machine homes, project files, and pi session transcripts under `~/.anon-pi/machines/*/home/.pi/agent/sessions/`) lives in YOUR login user's `$HOME`. A *different* coding agent running on the host as your normal login user can casually surface it: you ask that host agent "find my previous conversation about X" or "where's that work folder", and it `find`s / `grep`s your `$HOME` and stumbles onto the anonymized work. In an AI-driven workflow the transcript basically IS the work, so surfacing it re-associates "anonymized" activity with you.

The **hardened deployment** puts anon-pi's workspace under a dedicated Unix account, a **persona**, whose home is `chmod 700` and which your login user is *not* in. A casual `find`/`grep` as you then simply cannot read those files: plain Unix DAC does the work. You can have **many personas**, each a dedicated `anonpi-<name>` account (the default is the bare **`anonpi`**), each with its own mode-700 home *and its own fail-closed egress*, so two personas are unlinkable both on-host (separate DAC walls) AND on the network (separate exit IPs).

> **Account namespace: `anonpi` / `anonpi-<name>`, disjoint from `anonctl`.** anon-pi's accounts live in their own namespace on purpose. The sibling tool `anonctl` (a different anonymization model) owns the generic `anon` account and the `anon-<name>` prefix, so anon-pi deliberately never uses those: the default is `anonpi` (no hyphen after `anon`, so it is not the bare `anon` and cannot parse as a persona of it), and named personas are `anonpi-<name>`, which can never equal `anon` or `anon-<x>`. A persona name that would re-enter anonctl's namespace (the bare `anon`, or anything starting with `anon-`) is rejected, so the two tools' account spaces stay disjoint on a box that runs both.

> **Read this first: it is a DISCOVERABILITY + network-unlinkability boundary, NOT hard containment.** The on-host half defends only against an **unprivileged** host process/agent running as your login user (the accidental "find my old work" case). A host agent with **root**, or with **blanket passwordless sudo**, defeats that half entirely: root ignores file permissions. If your host agents already run with broad sudo, this buys you little on-host. anon-pi never claims otherwise, and neither should you.
>
> **Persona names are not secret from root.** A persona name unavoidably appears in `/etc/passwd`, `/etc/subuid`/`/etc/subgid`, `/etc/sudoers.d/anon-pi-<account>`, and the home path `~anonpi-<name>/`; root can always enumerate your personas. anon-pi keeps the name out of the **sudo/command audit log and your shell history** (see the provisioning notes below), which defends the **audit/history trail**, not root forensics. Do not over-trust the name-hiding.

### The sudo password is the feature, not friction

Crossing into a persona account requires a sudo **password** by default (the Tier-2 provisioning commands install a scoped sudoers rule with **no** `NOPASSWD`). That is deliberate: the password is what makes crossing the boundary a *conscious act you perform*, so an over-eager host agent's "find my work" never trips into it automatically. sudo caches the credential (~15 minutes), so day-to-day use is at most one prompt, not one per command. (There is an opt-in `--nopasswd` for a single-user trusted box only; it is OFF by default, and turning it on removes exactly this protection.)

### How you turn it on: `init` asks

Hardening is driven entirely by `anon-pi init` (the same onboarding you already run). There is **no `harden` verb, no `--hardened` flag, and no separate `anonpi` wrapper command**: anon-pi is its own wrapper. `init` asks (this step has **no default** — you answer `y` or `n` explicitly, an empty answer re-asks rather than silently declining):

```
Step 4/5 - hardened deployment
  Run under the dedicated `anonpi` account? (y/n, no default)
```

This provisions the **default persona `anonpi`**. Answer `y` and it walks a two-tier "actively help, never silent root" flow:

- **Tier 1 (rootless), done for you.** anon-pi points the workspace (`ANON_PI_HOME`) into the account's tree and `chmod 700`s it. No wrapper file is written, and `NETCAGE_GRAPHROOT` is never set (see the netcage note below).
- **Tier 2 (needs root), COMMANDS YOU paste into a root shell.** The parts that need root (create the account with `useradd -m anonpi`, `loginctl enable-linger anonpi` so its `$XDG_RUNTIME_DIR` exists without a login, install netcage system-wide so the account can run it, and install the scoped sudoers rule) are **printed as copy-paste commands**. You become root **first** (`sudo -i` or `su -`, in another terminal) and paste them into that root shell. anon-pi **never sudo's for you**, and it writes **no script file to disk**: nothing on disk to leak the account name, nothing to save, and entering one root shell keeps the account name out of your sudo/command audit log (the single `sudo -i` carries no name; commands typed inside a root shell are not individually audited). `useradd -m` **auto-allocates** the account's `/etc/subuid`+`/etc/subgid` block for rootless podman, so there is no explicit range line to paste. The sudoers rule is validated with `visudo -cf` before install, so a syntax error can never lock you out.
- **Resumable across the root step.** After printing the commands, `init` waits and tells you to run them, then press Enter to **re-check** (it re-probes the account with the preflight below). Once the account really exists and is fully provisioned, `init` continues and finishes. No separate command, no persisted "half-done" flag: the state is the OS, so re-running `init` after you paste the commands simply proceeds.

The preflight that gates the continue checks the account is set up correctly (subuid/subgid ranges present, linger on, `/dev/net/tun` accessible, the account's `$XDG_RUNTIME_DIR` present, and **netcage new enough** for its uid-scoped store, `>= 0.11.0`) and prints exactly what is missing with its fix, so a half-provisioned account fails loudly rather than cryptically.

> **Hardening requires a SYSTEM-WIDE anon-pi (and netcage).** The dedicated `anonpi` account runs anon-pi as *itself* (`sudo -u anonpi -i anon-pi ...`), so anon-pi must be installed where that account can execute it: a system PATH like `/usr/local/bin` or `/usr/bin`, via a **system Node**. A per-user Node manager (Volta, nvm, asdf, fnm) installs anon-pi under *your* home (`~/.volta/...`), which the `anonpi` account cannot reach or run, so the preflight **refuses** hardening (as its own step, since installing system-wide is a login-user action, not a root command) and tells you how to fix it: install Node.js system-wide (your per-user manager keeps precedence on your login shell, so a system Node does not change your normal workflow), then `sudo npm install -g anon-pi` (it lands on a shared PATH the account can run), and remove the per-user anon-pi (e.g. `volta uninstall anon-pi`) so you never run two different versions. Then re-run `anon-pi init`. netcage is the same: its default `~/.local/bin` install is unreachable cross-account, so the Tier-2 commands include a system-wide netcage install (`curl -fsSL .../install.sh | PREFIX=/usr/local/bin sh`). This constraint is **hardening-only** — a non-hardened anon-pi via Volta/nvm is perfectly fine (it never crosses accounts).

### Day to day: one command, at most one prompt

Once hardened, you keep using anon-pi exactly as before: `anon-pi recon`, `anon-pi --shell`, whatever. Those run as the **default persona `anonpi`**. To run as a different persona, add **`--as <name>`**: `anon-pi --as alice --shell` runs as `anonpi-alice`. On a hardened install anon-pi **detects that it must run as the selected persona and re-execs itself** as the very first thing it does, by spawning `sudo -u anonpi-<name> -i anon-pi "$@"` (the login `-i` form, so `$HOME`/`$XDG_RUNTIME_DIR`/env become the account's, which rootless podman needs; `anonpi-<name>` is `anonpi` for the default). The first call prompts for the sudo password; subsequent calls within sudo's cache window do not. A process already running *as* the selected persona does not re-exec (no loop). Where sudoers is not configured, the documented fallback is `su - anonpi-<name> -c 'anon-pi ...'`.

`--as <name>` is a plain argument (it can appear in your shell history / `ps`; that is accepted, the name is already in `/etc/passwd` anyway). It is stripped from what netcage sees but survives into the re-exec. Naming a persona you have not created is an **error** (`no persona \`<name>\`; create it with \`anon-pi persona add <name>\``), never a silent create and never a silent fall-through to `anonpi`. `--version` stays local (no redirect).

This always-redirects: on a hardened install *every* login-user invocation goes to a persona (the default `anonpi`, or the one you `--as`). There is no "run non-hardened on this box too" mode. A box you want non-hardened is simply a box you did not harden. anon-pi implements no privilege-switching of its own: it only ever spawns `sudo`/`su`. It ships no setuid binary and sets no uid.

### More personas: `anon-pi persona add <name>`

The default persona `anonpi` is created at `init`. To add another, run **`anon-pi persona add <name>`** (the account becomes `anonpi-<name>`; `persona add` with no name refers to the default `anonpi`). It runs the SAME two-tier flow as `init`'s hardening, per persona: it prints the Tier-2 **copy-paste root commands** (you become root first with `sudo -i` / `su -`, then paste `useradd -m anonpi-<name>` / `loginctl enable-linger` / the scoped sudoers install into that root shell; anon-pi never runs them, and writes no script file), and once the account exists it does Tier 1 for you: creates the persona's mode-700 `~anonpi-<name>/.anon-pi` and writes the persona's own `config.json` carrying its egress. The flow is resumable: while the account is missing it prints the commands and waits; run them, then continue and it writes the config. Re-running `persona add <name>` for an already-provisioned persona is an idempotent no-op.

Persona **identity** (email, git config, credentials) is **your** job, configured inside the persona's home; anon-pi only gives you the isolated account + workspace + egress. What the persona is is whatever you make it inside its jail.

To tear a persona down, run **`anon-pi persona rm [<name>]`** (bare `rm` targets the default `anonpi`). Like `add`, it only **prints** the root commands (remove the scoped sudoers rule, `loginctl disable-linger`, then `userdel -r anonpi-<name>`) for you to paste into a root shell; anon-pi never runs them. Because `userdel -r` **deletes the account's home and all its anonymized transcripts** (irreversible), on a TTY it asks you to type the account name to confirm before printing, or pass `--yes` (without a TTY it refuses unless `--yes`). If the account does not exist it says so and the commands are harmless no-ops (useful to clean a leftover sudoers rule).

### Per-persona egress: each persona has its own exit

Each persona has its **own** socks5h proxy, chosen at `persona add` time and stored literally in that persona's own `config.json` (inside its mode-700 home, so your login user's workspace never holds any persona's proxy or name). No persona shares another's exit, and it is **fail-closed per persona**: a persona with no resolvable proxy refuses to launch, exactly like the global fail-closed today. There is no rotation knob. Two ways to give a persona an endpoint:

- **Tor multi-persona (preferred).** If a running Tor is detected (or you pass `--tor [<host:port>]`), anon-pi hands Tor the persona's **account name as the SOCKS-isolation username**, composing `socks5h://anonpi-<name>:x@127.0.0.1:9050` (`x` is an ignored placeholder). Tor's `IsolateSOCKSAuth` (on by default) then builds a **separate circuit and exit per persona** automatically, at near-zero cost: each persona gets an independent, self-expiring circuit with zero setup. This is the recommended path precisely because Tor isolates the personas for you.
- **Bring your own SOCKS.** Otherwise give a socks5h endpoint you run (`--proxy <socks5h-url>`, or answer the prompt): a distinct wireproxy / `ssh -D` port. anon-pi prints a **warning**: this endpoint must be **unique to this persona**, because two personas on one endpoint share an exit IP and become linkable (defeating the isolation that matters most), so prefer Tor. anon-pi keeps **no** list of used endpoints (it cannot read across personas' DAC walls), so BYO uniqueness is your responsibility.

Netcage's forced-egress invariant is untouched: still exactly one socks5h endpoint forced per launch, fail-closed, never guessed. Per-persona egress only changes *which* endpoint each persona uses and *which* account anon-pi runs as; it never weakens the jail.

### It composes with ephemeral runs

This stacks with the ephemeral-run idea (a launch that saves nothing) as belt-and-suspenders: ephemeral means there is **nothing to find**, and the hardened deployment means **what you do keep is out of casual reach**. The two are orthogonal and reinforce each other.

### netcage runs as the persona too (no extra config)

Because anon-pi runs netcage *as* the persona account, netcage's uid-scoped container store lands in that account's own path automatically and does not collide with your login user's store, nor with another persona's (netcage's uid-scoped-store fix, netcage ADR-0017, in netcage `>= 0.11.0`). anon-pi does **not** set `NETCAGE_GRAPHROOT`; the uid-scoped default is enough. The forced-egress invariant is untouched: hardening only changes *which user* anon-pi runs as (and, per persona, *which* proxy), never the jail.

### Not in v1: a standalone `harden` verb + migration

v1 hardens **only through `init`**, and a fresh `init` has nothing to import, so there is no existing-workspace migration. RE-hardening an *already-populated* login-user workspace (a `anon-pi harden` verb that imports/migrates your current `~/.anon-pi` behind the boundary) is a **documented future follow-up**, tracked as the `harden-command-with-import` idea. Until then, hardening is a fresh-install decision made at `init` time.

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

`anon-pi init` can build it for you: pick the shipped `Dockerfile.pi` and it builds the image and pins the result (fully-qualified as `localhost/anon-pi/pi:latest`).

**A note on where the image must live.** Since netcage v0.7.0, `netcage run` uses its own private podman store (a username-free graphroot under `/var/tmp/netcage-storage`), not your default rootless store. So an image must be in *netcage's* store for a launch to find it — otherwise podman tries to pull the `localhost/…` ref and fails. `anon-pi init` handles this: it prefers `netcage build` when your netcage exposes it, and otherwise builds with `podman` and loads the result into netcage's store for you. If you build by hand, do the same:

```sh
# from wherever this package's Dockerfile.pi is (e.g. node_modules/anon-pi)
podman build -t localhost/anon-pi/pi:latest -f Dockerfile.pi .
# make netcage's store see it (netcage >= 0.7.1 ships `netcage load` for this):
podman save localhost/anon-pi/pi:latest | podman --root /var/tmp/netcage-storage load
anon-pi machine set-image default localhost/anon-pi/pi:latest
```

`netcage images` lists what is in netcage's store. The image only needs `pi` reachable on `PATH`. anon-pi bind-mounts the machine home over the container's `/root` and seeds a fresh home from the image's staging dir, so the image needs **no `ENTRYPOINT` and no config volume**.

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
- **`--ephemeral` / `ANON_PI_EPHEMERAL` are GONE.** The container is **throwaway** now; there is no separate ephemeral mode.
- **`--keep` and `--rm` are GONE.** Every launch is throwaway (there is no flag to toggle it): passing either is an error. The exploratory "install, quit, re-enter" flow is served by snapshotting the running container into a named image (`anon-pi image snapshot <name>`) and pinning a machine to it (`anon-pi machine create <m> --image anon-pi/<name>:latest`), which is explicit and named instead of an inferred mutable pet container. Your pi config and conversations were never in the container anyway (they live in the machine home).
- **`machine snapshot` is now `image snapshot`.** Snapshot moved off the `machine` noun onto the new `image` noun: `anon-pi image snapshot <name>` commits the running container into `anon-pi/<name>:latest` (with provenance labels), and `--create-machine <m>` also builds a machine from it. See [Managing images](#managing-images).
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
- **A launch hangs on "Trying to pull `localhost/…`" (then a connection-refused pull error)** — the image is in your default podman store but not in netcage's private store (`/var/tmp/netcage-storage`), so podman treats the `localhost/…` name as a registry and tries to pull it. Load it into netcage's store: `podman save <ref> | podman --root /var/tmp/netcage-storage load` (check with `netcage images`). Re-running `anon-pi init` and rebuilding the image does this for you.
- **`no TTY` on a bare `anon-pi`** — the menu and interactive pi need a terminal. In a script, name the project and forward args: `anon-pi <project> <pi-args…>` (that path needs no TTY).
- **The exit IP looks like your home IP** — the proxy is not actually anonymizing. Re-run `anon-pi init`; its `netcage verify` step prints the real exit IP as proof. anon-pi never claims a provider, only shows you the exit.
- **A destructive verb won't run in a script** — `machine rm` / `--delete-home` / `--delete-project` confirm on a TTY and abort non-interactively; pass `--yes` to proceed unattended.
- **`--keep` / `--rm` say they are gone** — that is expected: every launch is throwaway now. To keep system changes you made in a session, `anon-pi image snapshot <name>` the **still-running** container into a named image, then pin a machine to it (`anon-pi machine create <m> --image anon-pi/<name>:latest`) and relaunch (`anon-pi -m <m>`). Your pi config + conversations persist regardless (they live in the machine home).

## Platform

anon-pi is **Linux-only**, because netcage's jail is built on Linux kernel primitives (network namespaces, nftables, `/dev/net/tun`, rootless Podman + pasta). There is no native macOS/Windows jail.

On macOS/Windows, Podman runs inside a Linux VM (`podman machine`), so netcage (and anon-pi) can run **inside that VM**. Two caveats matter for anon-pi:

- **`--allow-direct` to a LAN model is VM-boundary-sensitive.** "Directly over the LAN" means the *VM's* NIC, not your Mac/Windows host LAN, so a model at an RFC1918 address on the host network may not be directly reachable from inside the VM the way it is on bare Linux.
- **Host-loopback proxy reachback** (`ssh -D`/Tor on the host's `127.0.0.1`) is the host loopback, not the VM's.

Treat non-Linux as best-effort-via-VM, not supported.

## License

[AGPL-3.0-only](./LICENSE)
