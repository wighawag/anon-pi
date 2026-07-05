# anon-pi

## 0.17.0

### Minor Changes

- fd010f5: Implement the `container create` and `container enter` verb bodies (the durable
  named box lifecycle from the container ADR / `container-noun-parse-and-plan`
  foundation).

  - `anon-pi container create <name> [-i <ref>] [-m <machine>] [--mount <p>]
[<project>|--shell]` now instantiates a DURABLE jailed box: a `netcage run`
    WITHOUT `--rm` (so it survives exit), `--name`d and stamped with the
    `anon-pi.container=<name>` label. The image is FROZEN via the normal launch
    chain (`-i` > machine.json image > `ANON_PI_IMAGE`) and the cwd is FROZEN from
    the create-time mode word. `-m` picks the HOME and `--mount` composes exactly as
    a normal launch. Forced egress (the proxy + the one `--allow-direct`) and the
    two invariant mounts are intact: a durable box is still fully jailed. Creating a
    box whose name ALREADY exists FAILS FAST with a clear error (never a silent
    re-enter or clobber).
  - `anon-pi container enter <name>` now re-enters a STOPPED box via `netcage start
-it <ref>`, which re-stands the jail at the box's frozen cwd and re-supplies the
    forced egress (`start` stands the jail back up). An UNKNOWN name errors (never a
    silent success), and an already-RUNNING box is REFUSED with guidance (reach its
    in-jail servers via `forward` / `ports`, or `container rm` to reset it) rather
    than opening a second attach against the same filesystem.

  Boxes are read back off the `anon-pi.container` netcage label (a new pure
  `parseContainerBoxesJson` over `netcage ps -a --format json`), so there is no
  anon-pi-side registry file: the label IS the record. `container list` / `rm` land
  in a follow-up task.

- 99a3255: Implement the `container list` and `container rm` verb bodies, completing the
  four verbs of the `container` noun (the durable-box housekeeping from the
  container ADR / `container-noun` prd).

  - `anon-pi container list` prints your durable boxes, one tab-separated row each,
    with enough identity to tell them apart: the box NAME, its MACHINE and
    CWD/PROJECT (decoded off the `anon-pi.key` identity label the launch stamps),
    its IMAGE (read back per box via `netcage inspect`), and running-or-stopped. It
    is read-only and filtered to anon-pi durable boxes only (the
    `anon-pi.container` label): a throwaway launch and a netcage sidecar are
    dropped. There is NO anon-pi-side registry file: the netcage container + its
    labels ARE the record, mirroring how `image list` reads provenance off image
    labels.
  - `anon-pi container rm <name>` removes a durable box. A STOPPED box is removed
    directly (`netcage rm <ref>`). A RUNNING box is a live instance, so it is
    GUARDED: WITHOUT `--yes` it REFUSES with "it is running, re-run with --yes"
    guidance; WITH `--yes` it STOP-then-removes in one atomic call (`netcage rm -f
<ref>`), so the user never sees a half-removed box. An UNKNOWN name errors
    (never a silent success).

  `ContainerBox` (the pure `parseContainerBoxesJson` reader) now also carries the
  raw `anon-pi.key` label so `list` can show the machine + cwd off the label with
  no extra query.

- 355f650: Add the pure foundation of a new `container` noun: explicit durable named boxes
  (`create` / `enter` / `list` / `rm`) that SURVIVE exit, reintroducing the mutable
  single-box continuity ADR-0004 dropped, but as an explicit, opt-in, NAMED noun
  with no create-vs-enter inference.

  This lands the PURE parts + the wiring; the impure verb bodies follow:

  - `parseContainerArgs` parses the four verbs into a typed `ContainerCommand`.
    `create <name> [-i <ref>] [-m <machine>] [--mount <p>] [<project>|--shell]`
    freezes the box's image + cwd at create (so it takes the cwd mode word);
    `enter <name>` takes ONLY the name and grammatically REFUSES `-i` and a
    project/`--shell` (both frozen at create), pointing at re-create / `image
snapshot`.
  - `container` is now a RESERVED noun word (alongside `machine` / `image`): a
    project can no longer be named `container`.
  - The run-plan composition (`resolveRunPlan`) is parameterised on a `durable`
    shape: a durable plan OMITS `--rm`, `--name`s the container, and stamps an
    `anon-pi.container=<name>` label, while keeping the two invariant mounts and the
    forced-egress proxy + single `--allow-direct` EXACTLY as a throwaway launch. The
    `anon-pi.key` identity label is unchanged, so `forward` / `ports` resolve a
    RUNNING durable box just as they do a throwaway one.
  - `anon-pi container --help` and the `container` dispatch are live end-to-end; the
    create/enter/list/rm bodies are stubbed here (they land in follow-up tasks).

  This DELIBERATELY re-opens ADR-0004's "throwaway always" drop, but only for the
  opt-in `container` path (the bare launch stays throwaway). Recorded in
  `docs/adr/0005-container-noun-durable-boxes.md`, which SUPERSEDES ADR-0004's
  "lost capability" note. A durable box is still FULLY jailed; the jail is never
  weakened.

## 0.16.0

### Minor Changes

- e7297cc: Introduce the top-level `image` noun and move snapshot onto it, with provenance
  baked into the image as podman labels (ADR-0003 §1+2).

  BREAKING: `machine snapshot` is renamed to `image snapshot` (a days-old verb).
  `anon-pi image snapshot <name> [-m <machine>] [--create-machine <m>]` commits the
  running container into the clean tag `anon-pi/<name>:latest` (a same-name
  re-snapshot overwrites `:latest`; the previous image becomes dangling but keeps
  its provenance). Provenance is baked via `netcage commit -c 'LABEL …'`:
  `anon-pi.source-machine` (the committed container's machine), `anon-pi.source-image`
  (read from the running container via inspect, so it is accurate even when `-i`
  made the container's image diverge from the machine's pin; falls back to
  `machine.json.image`, else the label is omitted), and `anon-pi.snapshot-at`.
  Provenance is best-effort history, never a live pointer.

  New `anon-pi image list`: read-only, zero stored state. Reads the provenance
  labels straight off the images, surfacing every `anon-pi/*` image plus any
  dangling image still carrying an `anon-pi.source-machine` label (an orphaned
  snapshot whose `:latest` tag was overwritten), by its ID.

  `machine create <name> --image <ref>` is now provenance-aware: if `<ref>` was
  produced by `image snapshot` and its source machine's home still exists, the
  home-copy (minus sessions) + per-project session carry-over are offered (the
  same prompts the 0.15 snapshot ran). `image snapshot --create-machine <m>` is
  the one-step convenience for the common path. Both share one
  `carryOverHomeFromMachine` helper; both honor the no-TTY "copy nothing" rule.

  Also: the subcommand noun words (`machine`, `image`, `init`, `forward`, `ports`)
  are now reserved names, so a project/machine/image can no longer be named after a
  dispatched verb (closing a latent "unreachable folder" trap). A pre-existing
  project folder now reserved is silently skipped from the menu (never a crash),
  and creating such a name is refused with a clear "reserved name" error.

- f7142ac: Add the ephemeral per-launch image override `-i <ref>` / `--image <ref>` to the
  launch grammar (beside `-m`, `--shell`, `--mount`) (ADR-0003 §3).

  `-i` is the highest-priority image source: `-i` > `machine.json.image` >
  `ANON_PI_IMAGE` > error. It composes with `-m` (`-m` picks the HOME, `-i` picks
  the IMAGE) and is STRICTLY EPHEMERAL: it NEVER mutates `machine.json` (to re-pin
  a machine's image use `machine set-image` / `machine create --image`) and prints
  NO mismatch warning (`-i` is explicit + ephemeral, so a warning carries no
  information the user lacks).

  On a FRESH (unseeded) machine home `-i` is REFUSED with guidance: seeding the
  home from the ephemeral image would poison it with the wrong-image seed, so
  anon-pi points at `anon-pi machine create <m> --image <ref>` (or a normal launch
  to seed) instead. On an already-seeded home `-i` just runs the override image
  against the existing home (the runtime extension-compat risk is accepted
  silently, per ADR-0003).

  `-i` resolves in NETCAGE'S private image store (where `anon-pi/<name>:latest`
  snapshots and `init`-built images live), NOT the operator's default podman
  store. anon-pi does NOT pre-check the ref and does NOT auto-pull (an anonymity
  tool must not silently fetch a remote image); netcage/podman surfaces its own
  "not found" via inherited stdio. The `--help` text documents this store boundary
  so a "not found" is understood (fix: `image snapshot` it, or build it into
  netcage's store).

- 0b31321: Retire `--keep`/`--rm`: every launch is now throwaway (the container is always
  `--rm`).

  BREAKING: the `--keep` and `--rm` launch flags are removed. Passing either now
  errors with guidance toward image-based persistence: snapshot the running
  container into a named image (`anon-pi image snapshot <name>`) and pin a
  machine to it (`anon-pi machine create <m> --image anon-pi/<name>:latest`). The exploratory
  "apt install, quit, re-enter" pet-container flow (and the kept-container
  run-vs-start inference behind it) is gone; durable state is explicit and named
  instead of an inferred mutable container. Your pi config and conversations live
  in the machine home (a host mount) and persist regardless.

  `forward`, `ports`, and `image snapshot` are unchanged: anon-pi still stamps
  its `anon-pi.key` identity label on every launch and reads it back to resolve a
  running container by machine + project (the label survives; only the
  kept-container matching was removed).

  Per the ADR-0004 rollout, this ships as part of the combined 0.16.0 release
  alongside the `image` noun and the `-i` launch override.

## 0.15.0

### Minor Changes

- 1de59d6: `machine snapshot` now carries the source machine's HOME into the new machine
  instead of leaving it fresh. The home is copied entirely EXCEPT its conversations
  (config, extensions, downloaded tool binaries, dotfiles, the seed marker), which
  is safe and preferable here because the new image IS the committed source
  filesystem, so the copied extensions/binaries are correct for it (and the new
  home is not re-seeded).

  Conversations are handled deliberately: on a TTY you are offered each one grouped
  BY PROJECT, opt-in per project (default SKIP), choosing COPY or SKIP for each
  (with no TTY, none are copied, so scripted snapshots stay clean). COPY never
  touches the source machine; after copying, a single confirmed step (default No)
  can DELETE the copied groups from the source machine (the only way to "move" a
  conversation out). This keeps the per-machine-history isolation intact: a
  snapshot does not silently inherit the source machine's whole history.

## 0.14.0

### Minor Changes

- 1f3f166: `machine snapshot` is now container-first: `anon-pi machine snapshot <new-name>
[-m <machine>] [--image-tag <ref>]`. The sole positional is the NEW machine
  name; the running container to commit is auto-detected from the running anon-pi
  containers (a picker when several are up), and `-m <machine>` is an OPTIONAL
  narrowing filter, NOT a required source. This drops the awkward mandatory
  source-machine positional from the initial 0.13.0 shape: what matters is the
  container to snapshot, and the machine is only a filter, exactly as it is for
  `forward`/`ports`.

## 0.13.0

### Minor Changes

- 829f02e: Add `anon-pi machine snapshot <machine> <new-name> [--image-tag <ref>]`: commit
  the current filesystem of a machine's RUNNING jailed container into a new image
  and create a new machine pinned to it. This lets you preserve an environment you
  built interactively (e.g. after `sudo apt install`) WITHOUT having pre-decided
  `--keep`, as long as the session is still running (the default `--rm` deletes
  the container on exit). podman pauses the container briefly during the commit,
  so the live session survives; the new machine gets a fresh home (the image is
  the software, the home is a separate host mount) and relaunches through the same
  forced-egress jail.

## 0.12.0

### Minor Changes

- 44a07f4: `--shell` with no project now lands at the projects root (`/projects`, or
  `/work` under `--mount`) instead of the machine home (`/root`). The model is
  project-centric and the shell is the project-hopper, so the projects root is the
  natural landing; anything written under the machine home persists into that
  machine's config home on the host, which is for config, not work. `--shell .` is
  now an exact synonym for a bare `--shell`, and the machine home is still one
  `cd ~` away inside the jail.

## 0.11.1

### Patch Changes

- c9822ad: Fix `forward`/`ports` (and `--keep` run-vs-start) container resolution: read
  netcage's managed containers via `netcage ps --format json`.

  The container lookup parsed `netcage ps` with a `{{.ID}}\t{{.Labels}}` Go
  template, but netcage < 0.10.0 ignored `--format` and printed a fixed human
  table with no Labels column, so anon-pi never found a running container:
  `anon-pi forward` always reported "no running anon-pi container" (and `--keep`
  always fell back to a fresh run instead of resuming). netcage 0.10.0 makes
  `ps`/`inspect` forward podman's read-only output flags, so anon-pi now queries
  `netcage ps --format json` and parses the structured `Labels` object (a robust
  `parseNetcagePsJson`), decoding the `anon-pi.key` label to match the container.
  `forward`/`ports` therefore require **netcage >= 0.10.0**.

  Also: the "entering the netcage jail" status line no longer prints for
  `forward` (it attaches to an existing jail, and prints its own "forwarding to …"
  line); it stays on the launch paths (`run`/`start`) where the jail is set up.

## 0.11.0

### Minor Changes

- 1a47ca3: Add `anon-pi forward` and `anon-pi ports`: reach an in-jail server from the host
  (wraps netcage >= 0.9.0's host-access verbs).

  - **`anon-pi forward [<project>] [--port <[hostPort:]jailPort>] [--bind <addr>]
[-m <machine>]`** opens a host port onto a running container's in-jail server
    (a dev/preview server, a local API), the way `kubectl port-forward` / `ssh -L`
    work. It resolves the running anon-pi container(s) for you (no raw netcage
    container name), and shells out to `netcage forward`. The port is host-first
    like docker/kubectl, so `--port 8080:3001` binds host 8080 onto jail 3001;
    `--bind 0.0.0.0` (passed through to netcage) exposes it on the LAN. The bare
    positional is ALWAYS the project (a numeric name like `3001` is a project,
    never a port), and it only filters the candidates. If several containers match
    you pick one from a list annotated with each one's open in-jail ports. Omit
    `--port` to be shown the container's listeners and prompted for the jail port
    and an optional different host port; an explicit `--port` may name a port that
    is not open yet (the forward binds the host side immediately).
  - **`anon-pi ports [<project>] [-m <machine>]`** lists a running container's open
    in-jail TCP listeners via `netcage ports --json`, image-independently (netcage
    reads `/proc/net/tcp*` via the sidecar, so it works even with no
    `ss`/`netstat`/`nc` in the image). Use it to find which port to forward.
  - **Every launch now stamps the anon-pi identity label** (previously only
    `--keep` did), so `forward`/`ports` can find the running container even for a
    throwaway `--rm` launch. The label is additive and egress-neutral; `--rm`
    still removes the container on exit.

## 0.10.0

### Minor Changes

- a4114a9: Resume a session in its own project, and make `--fork`/`--continue` require a
  project.

  - **`anon-pi --session <id>` (and `--session-id`/`--resume`/`-r`) now resume in
    place.** anon-pi looks the session id up in the machine's session store, reads
    the project cwd it belongs to (from the session file's header record), and
    launches pi with `-w <that cwd>`. So pi reopens the conversation directly
    instead of prompting `Session found in different project: … Fork? [y/N]`
    (which happened because anon-pi previously launched pi at the projects root,
    a cwd that never matched the session). An unresolvable id falls back to the
    old behaviour (launch at the projects root, let pi decide), so it is pure
    upside. An explicitly named project still wins (the user is trusted; pi's own
    fork-prompt guards a genuine cwd mismatch).
  - **`--fork` and `--continue`/`-c` now require a project.** With no project they
    would land a new (`--fork`) or newest (`--continue`) conversation in the
    projects root by surprise. anon-pi now refuses them without a project and
    points you at a copy-pasteable fix: `anon-pi <project> --fork <id>` (the
    project may be `.` for the root, and is created on demand, so
    `anon-pi newproj --fork <id>` forks into a fresh `/projects/newproj`).

## 0.9.1

### Patch Changes

- 6c55142: Print a status line before entering the jail, and refresh the build-verb docs
  for netcage 0.7.1.

  - **Explain the launch pause.** Every launch now prints
    `anon-pi: entering the netcage jail (setting up forced-egress)…` (to stderr)
    right before spawning netcage. netcage sets up the jail (netns, firewall, DNS,
    container start) before pi paints, so without this the user saw only a blinking
    cursor during the gap. The message is transient (pi clears the screen when its
    TUI comes up) and covers the menu, direct, and shell launch paths through the
    single `spawnNetcage` chokepoint.
  - **Docs honesty for netcage 0.7.1.** The `netcage build`/`load` verbs shipped in
    netcage 0.7.1, so the README and `buildImage`/`loadImageIntoNetcageStore`
    comments no longer frame them as a "future"/"interim" workaround. The preferred
    native `netcage build` path is unchanged.

## 0.9.0

### Minor Changes

- f0a8de9: Fix launches against netcage v0.7.0's private image store, expand `~` in paths,
  reuse netcage's proxy scanner, and fully-qualify built image tags.

  - **Build images into netcage's store.** Since netcage v0.7.0 every `netcage run`
    uses a private podman graphroot (`/var/tmp/netcage-storage`), not your default
    rootless store, so a plain `podman build` image was invisible to launches
    (podman tried to pull the `localhost/…` ref and failed — which looked like a
    hang). `init` now prefers `netcage build` when available, and otherwise builds
    with podman and loads the image into netcage's store. `resolveNetcageGraphroot`
    honours `NETCAGE_GRAPHROOT`.
  - **Fully-qualified image tags.** `init` now tags built images
    `localhost/anon-pi/pi[-webveil]:latest` (podman refuses an unqualified short
    name at run time).
  - **Expand `~` in host paths.** The `init` projects-root step and `--mount` now
    expand a leading `~`/`~/` to `$HOME` (`path.resolve` alone left a literal `~`
    dir), and config/env projects-root values are expanded too.
  - **Reuse netcage's SOCKS scanner.** `init`'s proxy step uses `netcage
detect-proxy --json` (its probe + SOCKS5 handshake + process hint) when
    available, falling back to anon-pi's own local probe; findings render through
    the same honest formatter (never labels the provider).
  - **README** is now the repo-root `README.md` (source of truth), copied into the
    package at build/pack time.

## 0.8.0

### Minor Changes

- e2115e6: Forward pi's session-resume flags, so `anon-pi --session <id>` works.

  pi prints `To resume this session: pi --session <id>` on exit. That command is
  now usable by just prefixing `anon-pi`:

  - `anon-pi --session <id>` / `--session-id <id>` / `--resume` (`-r`) /
    `--continue` (`-c`) / `--fork <id>` launch pi with NO anon-pi project and
    forward the flag(s) verbatim. pi resolves the session by id (session files live
    in the always-mounted machine home) and switches to its own project cwd, so no
    project is needed. `-m <machine>` before the flag still picks the machine.
  - Fixed the no-TTY discipline: a forwarded run is treated as HEADLESS (no TTY
    required) ONLY when it forwards pi's `-p`/`--print`. Other forwarded flags
    (e.g. `--session`, `--model`) stay INTERACTIVE and keep the TTY + `-it`
    (previously any forwarded arg was wrongly treated as headless).
  - `--shell` + a session flag is a clear error (a shell has no session to resume).

- 206a980: Add `--version`, `--list-models`, and the `anon-pi pi <args…>` passthrough.

  - **`anon-pi --version` / `-V`** prints anon-pi's own version (it previously
    errored). For pi's version inside the jail, use `anon-pi pi --version`.
  - **`anon-pi --list-models` / `--models`** lists the models pi sees, with no
    project needed (a pi query that prints and exits).
  - **`anon-pi pi <args…>`** is a general passthrough: run pi inside the jail with
    ANY args and no project (`anon-pi pi --model x`, `anon-pi pi --export out.html
--session <id>`), so anon-pi never has to special-case each pi flag. `pi` is
    reserved as a project name so the token cannot be shadowed.

  These slot into the same no-project pi-launch mechanism as `--session` (cwd at
  the projects root, interactive unless `-p`/`--print` is forwarded, forced-egress
  jail intact). Combined pi flags already work everywhere:
  `anon-pi --session <id> --model qwen`, `anon-pi recon --model x --thinking high`.

## 0.7.0

### Minor Changes

- 53e0af7: The local-model seed is now GLOBAL (shared by every machine), not per-`default`.

  Because `config.json` holds one `llm` endpoint (the single `--allow-direct` hole,
  shared across machines), the generated `models.json` describing it should be
  shared too — previously it lived under `machines/default/` and only that machine
  got it, so a second machine launched with an empty models list.

  - `init` now writes a **global** `~/.anon-pi/models.json` + `settings-seed.json`,
    and updates every ALREADY-seeded machine home in place (conversations
    untouched) so a re-run actually takes effect.
  - Every machine's fresh-home seed resolves the global seed by default, with an
    optional per-machine override (`machines/<M>/models.json`) for the rare case
    where a machine points at a different local model.
  - Migration: `init` removes the old `machines/default/models.json` +
    `settings-seed.json` it wrote in prior versions, so `default` picks up the
    global seed like every other machine.

  This also fixes: re-running `init` now updates an existing home (prior versions
  wrote the seed but the marker-guarded first-launch promotion never re-applied it
  to an already-seeded home).

## 0.6.0

### Minor Changes

- 33c5b3f: First-run onboarding + a projects-root step in `init`.

  - **Auto-onboard on first launch.** Running a launch (e.g. `anon-pi` or
    `anon-pi <project>`) with no `config.json` yet now shows a short welcome and
    runs `anon-pi init` automatically, then continues into the launch — instead of
    failing deep with the bare "set `ANON_PI_PROXY`" guidance the first time. It
    only auto-onboards on an interactive terminal; a script (no TTY) still gets the
    fail-closed proxy error, and an env-driven run (`ANON_PI_PROXY` set) skips
    onboarding entirely.
  - **`init` gained a projects-root step (now 4 steps).** After the image step,
    `init` asks for the projects root — the host folder mounted at `/projects`
    where bare `anon-pi` looks for projects — defaulting to `~/.anon-pi/projects/`.
    Point it at your own dev folder to jail pi into files you edit with host tools;
    `--mount <parent>` still overrides it per-launch. Accepting the default leaves
    `config.json` clean (no explicit `projects` key).

- 2722779: `init` now imports real models for the local endpoint (and sets a default).

  Previously the generated `models.json` had an empty models list, so pi saw the
  provider but had no pickable model. The local-model step now:

  - **Merges two endpoint-scoped sources**: the provider in your own
    `~/.pi/agent/models.json` whose baseUrl matches the endpoint (marked
    `[configured]` — your hand-tuned entries, with their `contextWindow`/
    `maxTokens`/etc. preserved) and the endpoint's live `GET /v1/models` (marked
    `[server]`). ONLY the provider served by the endpoint (the one
    `--allow-direct` hole) is ever read, so no other provider — and no other key —
    can enter the seed.
  - **Lets you choose** which models to import (Enter/`c` = all configured, `a` =
    all server+configured, numbers, `s` = skip) and **which is the default**.
  - Writes `models.json` (the chosen entries under the neutral `local` provider)
    **and** a settings seed that the first-launch promotion merges into the home's
    `settings.json` — setting `defaultProvider`/`defaultModel`/`enabledModels`
    without clobbering image-staged packages/extensions.
  - **Refuses a real apiKey by default**: if the matching host provider carries a
    non-benign apiKey, init aborts (a host credential should not enter the anon
    home) unless you pass `--force-allow-local-llm-api-key`, which carries it
    through with a warning.

## 0.5.0

### Minor Changes

- e513a8f: Land the bare-launch **interactive menu**: bare `anon-pi` (and bare `-m
<machine>` / `--mount <parent>` with no project) now shows a host-side arrow-key
  menu BEFORE any jail runs, and launches the chosen thing on Enter.

  The menu is a PURE host-side read (no jail runs until you pick): it lists the
  active root's projects (`readdir`) plus each machine's pi session dirs
  (`readdir`) and feeds them to the pure `buildMenuChoiceList` /
  `deriveProjectUsage` / `buildMenuEntries`. Each project row is ANNOTATED with the
  machines it has been used on and flags whether the current machine is new for it
  (`used on: <machines>; new here`), derived from session-dir presence, no marker
  file. Conversations are per-machine, project files are global.

  Selection dispatches to the SAME launch paths as the equivalent typed command
  (re-resolved through `resolveRunPlan` + a shared `executeLaunchPlan`, so a menu
  pick launches byte-for-byte identically): a project or the `.` "here" entry -> pi
  (`/projects/<name>` or the root itself); `+ new project…` -> prompt + validate a
  name (`validateName`) then pi; `shell` -> the `--shell` jailed bash.

  The selector is a HAND-ROLLED, zero-dependency raw-mode `select()` (a small
  supply-chain surface is on-brand for a security tool; the list is short):
  up/down (arrows or `k`/`j`) move a `>` cursor over a highlighted row, Enter
  selects, Ctrl-C / `q` / Esc cancels, and the terminal is ALWAYS restored (raw
  mode off, cursor shown) on every exit path. It is isolated behind a tiny
  signature so a prompt lib could swap in later as a localized change. No-TTY reuses
  the bare-launch error (the menu never runs without a terminal).

  New PURE, unit-tested exports in `src/anon-pi.ts`: `MenuEntry` /
  `MenuEntryKind`, `buildMenuEntries`, `formatProjectAnnotation`, and the fixed
  labels `MENU_HERE_LABEL` / `MENU_NEW_LABEL` / `MENU_SHELL_LABEL`. ALL the menu's
  logic (entry order + annotation wording) lives in the pure module; the raw-mode
  render/select is the only untested I/O.

- e0ccad1: Add the destructive cleanup verbs `anon-pi --delete-home [<machine>]` and
  `anon-pi --delete-project <project>` to `src/cli.ts`, replacing the old
  `--fresh`. The pure module (`src/anon-pi.ts`) resolves the affected host paths;
  the CLI does only the I/O (read config, filter to existing paths, run the
  confirm/`--yes`/non-TTY discipline, then `rm`).

  - **`--delete-home [<machine>]`**: deletes ONE machine's HOME (config + convos +
    shell env), keeping its `machine.json` image pin (so it can be relaunched to
    seed a FRESH home) and ALL project files (they live under the projects root).
    The default machine (`config.defaultMachine`, else the built-in
    `DEFAULT_MACHINE`) is used when the name is omitted.
  - **`--delete-project <project>`**: deletes the project's FILES (its folder under
    the resolved projects root) AND that project's per-machine session dir in EVERY
    machine home (the machine-invariant `/projects/<name>` slug), keeping the homes
    otherwise intact. The project name is REQUIRED.

  Both confirm `[y/N]` on a TTY, take `--yes` / `-y` to skip, and ABORT on a
  non-TTY without `--yes` (never delete unprompted in a script), matching the
  existing `machine rm` discipline. Both honour the prd behaviour table:
  delete-project drops that project's sessions everywhere but keeps the homes;
  delete-home drops one machine's convos but keeps the project files.

  New pure exports (all path-only, unit-testable): `SESSIONS_DIRNAME`,
  `machineAgentDir`, `machineSessionsDir`, `machineProjectSessionDir`,
  `resolveDeleteHome` (-> `DeleteHomePlan`), and `resolveDeleteProject`
  (-> `DeleteProjectPlan`).

- 0cd3698: Add `anon-pi init`: the honest, re-runnable onboarding that captures the
  socks5h **proxy**, the local-model endpoint, and the default machine image, then
  writes `config.json` + the `default` machine. It REPLACES the old `import`.

  The load-bearing HONESTY constraint (this is an anonymity tool): the proxy step
  presents EVIDENCE only and NEVER claims/labels the exit provider. A SOCKS proxy
  does not announce Mullvad/Proton/etc, so a false label would be a dangerous lie.

  Flow (`src/cli.ts`, with the DECISIONS pure in `src/anon-pi.ts`):

  1. **Proxy**: probes common SOCKS ports (9050 Tor, 9150 Tor Browser, 1080
     generic wireproxy/ssh -D), CONFIRMS each really speaks SOCKS5 via a real
     method-selection handshake, and shows the findings as EVIDENCE (open + SOCKS5
     verdict + a structural port hint + a WEAK local process hint like "a `tor`
     process is running -> likely Tor") with NO provider label. You choose a
     confirmed port or enter `host:port`; it then runs
     `netcage verify --proxy socks5h://<chosen>` and shows the real EXIT IP as
     proof it is not the host IP. You confirm on that evidence.
  2. **Local model endpoint**: captures `host:port`, probes reachability
     (evidence, not a gate), and generates the machine's `models.json` from it via
     the pure `generateModelsJson` (the `import` replacement: no host pi config is
     read, so no other provider / paid key / session identity can leak).
  3. **Default machine image**: a menu from the shipped Dockerfiles (`Dockerfile.pi`
     / `examples/Dockerfile.pi-webveil`, built via `podman build`), an existing
     image ref, or skip (imageless; pinned later).
  4. Writes `config.json` (`{ proxy, llm, defaultMachine }`) + the `default`
     machine. Re-runnable: it pre-fills current values and NEVER destroys machines
     or homes (an existing home is kept intact; an existing machine is only re-pinned
     when a new image is chosen).

  New PURE exports in `src/anon-pi.ts` (all unit-tested): `DEFAULT_SOCKS_PROBE_PORTS`,
  `SOCKS5_METHOD_SELECTOR`, `interpretSocks5Handshake`, `processHint`,
  `formatProxyFindings` (+ `FORBIDDEN_PROVIDER_LABELS`, with a test asserting the
  formatter NEVER emits a provider label), `socks5hUrl`, `parseVerifyExitIp`,
  `initImageMenu`, and `serializeConfigJson`. The socket probes, the `netcage
verify` / `podman build` spawns, and the prompts are the thin impure I/O.

  `anon-pi init --help` now shows init's own help (the global `--help` yields to a
  subcommand that owns one). `import` is gone.

- 6f37dfa: Rewrite the `src/cli.ts` launch path onto the machines + projects workspace
  surface (grammar A). This is the breaking cutover from the 0.4.0 per-workdir
  model.

  - **Grammar A parsing** (new pure `parseLaunchArgs` in `src/anon-pi.ts`): a bare
    positional is a PROJECT; `-m <machine>` picks the machine; `--shell [<p>]` runs
    a jailed bash; `--mount <parent> [<p>]` roots at a HOST parent; `--keep`/`--rm`
    (throwaway default); the `.` root token; trailing `<pi-args…>` after the
    project are forwarded to pi verbatim. Enforces the reserved-name guard (via
    `validateName`) and rejects unknown options / a missing `-m`/`--mount`
    argument / a contradictory `--keep --rm`. `DEFAULT_MACHINE` = `default`.
  - The CLI reads `config.json` / a machine's `machine.json`, resolves the machine
    (`-m` > `config.defaultMachine` > `default`) + its image (machine.json, else
    `ANON_PI_IMAGE`), the forced-egress inputs (proxy REQUIRED/fail-closed, llm),
    and the projects root, then resolves the `RunPlan` (pure `resolveRunPlan`) and
    spawns `netcage` with inherited stdio, propagating the exit code. The composed
    argv ALWAYS carries `--proxy` + the one `--allow-direct` (the RunPlan's
    guarantee; the CLI never strips or adds egress).
  - **No-TTY discipline**: the bare menu and every interactive launch (interactive
    pi, a shell) require a TTY and error clearly without one; a headless
    `<project> <pi-args…>` run does not.
  - **Run-vs-start**: under `--keep`, the CLI queries netcage for its kept
    `netcage.managed` containers (stamping/reading back an `anon-pi.key` label) and
    `netcage start`s a matching one (pure `resolveRunVsStart`), else `netcage run`
    without `--rm`; `--rm`/default is always a fresh `netcage run --rm`.
  - Bare launch dispatches to a menu hook (a stub that points the user at direct
    launch; the interactive TUI lands in the follow-on task).

  **Breaking / removed** (migration for 0.4.0 users): a bare positional is now a
  PROJECT, not a host WORKDIR path; `--ephemeral`/`--fresh` and the `import`
  subcommand are gone from the CLI (their replacements `--rm` / `init` /
  `--delete-home` land in the surrounding tasks), and the per-workdir
  `state/<slug>/` home model is not migrated. The `HELP` string is rewritten to
  the new model. The old pure symbols (`buildRunPlan` / `stateAgentDir` /
  `resolveConfigSeed` / `pickProviderForLlm` / `resolveSourceModelsPath`) and the
  dead `AnonPiEnv` fields remain defined-and-exported (their deletion is the
  follow-on `retire-legacy-pure-surface` task), so the build stays green.

- 8b74d40: Add the `anon-pi machine {create,list,set-image,rm}` verbs to `src/cli.ts`,
  making machines first-class (an image + a persistent host home,
  `machines/<name>/{machine.json,home/}`). Dispatch stays thin; the parse,
  validation, machine.json serialisation, and the set-image warning wording live
  in the pure module (`src/anon-pi.ts`).

  - **`machine create <name> [--image <ref>]`**: validates the name (reserved-name
    / traversal guard via `validateName`), writes `machines/<name>/machine.json` +
    `home/`, and pins the image (from `--image`, else a TTY prompt; a non-TTY
    create without `--image` aborts). The home is a dir only here; it is SEEDED on
    first LAUNCH, not at create. Refuses to clobber an existing machine.
  - **`machine list`**: prints each machine and its pinned image (reads each
    machine's `machine.json`; a missing image shows `(no image)`). An empty
    workspace reports so clearly.
  - **`machine set-image <name> <ref>`**: RE-PINS the image and prints a
    compatibility WARNING only. It does NOT reseed or touch the home (the home's
    extensions / downloaded tools were built for the OLD image); the warning names
    the two remedies (`pi install` inside the machine, or `--delete-home` to
    reseed). Preserves a per-machine `projects` override across the re-pin.
  - **`machine rm <name> [--yes]`**: deletes the machine dir (its `machine.json` +
    home) after a confirm, mirroring the destructive-verb discipline: confirm on a
    TTY, `--yes` / `-y` skips it, and a non-TTY WITHOUT `--yes` ABORTS (never
    deletes unprompted in a script).

  New pure exports: `parseMachineArgs` (the `machine <verb> …` grammar ->
  `MachineCommand`), `serializeMachineJson`, and `setImageWarning`. The `machine`
  subcommand is dispatched before the launch grammar, so `machine` is never parsed
  as a project name.

- dfd894a: Align the shipped images with the machines + projects vocabulary: the container
  projects root is now `/projects` (was `/work`), so the concept is "project"
  everywhere and the images agree with the RunPlan's paths.

  - `Dockerfile.pi` and `examples/Dockerfile.pi-webveil`: `WORKDIR` is now
    `/projects` (the projects-root cwd, pi's default). `/work` is kept as the
    DISTINCT `--mount` root, so the two roots never collide.
  - The staged `trust.json` (in `/opt/anon-pi-seed/agent`, promoted into the
    machine home on first launch) now trusts BOTH cwd roots pi launches into,
    `/projects` and `/work`, so pi never prompts on the mounted project on any
    launch mode.
  - `Dockerfile.pi` seeds base `/root` shell dotfiles (`.bashrc`, `.profile`) from
    `/etc/skel` if absent, so a fresh machine home has defaults to fall back to
    (the home bind-mounts over `/root`).

- dd9cc4f: Add the per-machine RunPlan resolver (`resolveRunPlan`) to `src/anon-pi.ts`: the
  pure heart of the machines + projects rework. Given a resolved launch intent
  (machine + mode + project token + the forced-egress inputs) it composes the
  `netcage` argv for every launch mode, holding the forced-egress invariant on
  every path.

  - Modes (`LaunchMode`, `LaunchIntent`, `LaunchPlan`): `menu` (bare) yields an
    argv-less marker (the host-side TUI runs first); `pi <project>` cwds into
    `/projects/<project>` (or `/projects` for `.`) and forwards `<pi-args…>` to
    `pi`; `shell [project]` runs `bash` at `/root` (the machine home) or the
    project cwd; `--mount <parent>` re-roots into `/work[/<project>]`.
  - The TWO invariant container mounts are ALWAYS present: `<home>:/root` and
    `<projects-root>:/projects`. `--mount` adds EXACTLY one parent mount at a
    distinct `/work` and changes nothing else (sidesteps podman mount
    immutability).
  - `--rm` (throwaway) is the DEFAULT; `--keep` omits it to leave a kept
    container. The machine home mount survives on every path (it is a host mount).
  - Marker-guarded seed-if-fresh keyed per MACHINE home (reuses the
    `containerRunCmd` seed shape re-pointed at `/root`), promoting the image's
    staged pi defaults + the generated `models.json` into a fresh home once.
  - Forced egress is a HARD invariant: every composed argv carries `--proxy <p>`
    and exactly one `--allow-direct <llm>`; a plan can never be produced without
    the proxy or the direct hole (fail-closed).
  - Adds the `CONTAINER_HOME_ROOT` (`/root`) constant for the machine home bind
    path, distinct from the `~` menu token.

  Additive: the legacy per-workdir `buildRunPlan` (still called by `cli.ts`) is
  left dead-but-present; its coordinated removal is owned by a later task.

- 18a8e89: Add the pure machine + project resolvers, name validation, and the `.` root
  token to `src/anon-pi.ts` (built on the workspace-layout foundation).

  - Name validation (`validateName`, `NameKind`, `RESERVED_NAMES`): a machine or
    project name must be a single folder segment. Rejects `/ \ :`, whitespace, a
    leading dot (incl. `.`), the `..` traversal token, and reserved names, raising
    `AnonPiError` with a clear message naming the kind.
  - Project resolvers: `projectHostDir(projectsRoot, name)` maps a validated name
    to its host subfolder under the resolved projects root, and
    `projectContainerCwd(name)` gives the jail cwd `/projects/<name>` (pi's
    conversation key).
  - The `.` root token (`ROOT_TOKEN`, `isRootToken`) and a uniform cwd resolver
    (`resolveCwd`, `rootCwd`, `RootKind`): `.` means "the root itself" in every
    context, mapping to `/projects` (`CONTAINER_PROJECTS_ROOT`), `/work`
    (`CONTAINER_MOUNT_ROOT`, `--mount`), or `~` (`CONTAINER_MACHINE_HOME`, a
    machine home). A named project resolves to `<root>/<name>` under the projects
    or mount roots; a machine root takes only `.`.

  Pure and additive (no filesystem side effects); the CLI wires these to real
  dirs and composes the netcage argv in later tasks.

- 88b68f4: Add the pure bare-launch menu choice-list + per-machine project-usage record to
  `src/anon-pi.ts` (the data the host-side menu renders; the TUI is a later task).

  - `projectSessionSlug(name)`: the pi session-dir slug for a project, i.e.
    `pathSlug` of its jail cwd `/projects/<name>`. It is MACHINE-INVARIANT (the
    cwd is the same on every machine, since files are global), so the same shared
    project is recognised in each machine's `sessions/` dir. Matches pi's own
    session-manager convention (`--projects-<name>--`).
  - `buildMenuChoiceList({projects, canNew?, canShell?})` -> `MenuChoiceList`
    `{ projects, here, canNew, canShell }`: computed from a SUPPLIED projects-root
    listing. Non-project entries (dotfiles, `..`, separators, whitespace, reserved
    tokens) are dropped; surviving names are sorted case-insensitively for a
    stable menu; `here` is the `.` root token (a scratch pi at the root itself);
    `canNew` / `canShell` default true (affordance gates for later policy).
  - `deriveProjectUsage({projects, currentMachine, sessions})` -> `ProjectUsage[]`
    `{ project, machines, currentMachineIsNew }`: DERIVED from a SUPPLIED
    per-machine session-dir listing (`SessionDirListing`, no marker file). Each
    project maps to the (sorted) machines whose home contains its session slug,
    preserving the supplied project order; `currentMachineIsNew` is true when the
    current machine has no session dir for the project yet.

  Pure and additive (no filesystem side effects): the CLI reads the real projects
  root + each machine home's `sessions/` dir and renders the menu in a later task.

- ee7d2bb: Add a PURE `models.json` generator (`generateModelsJson`) to `src/anon-pi.ts`:
  given a single `llm` endpoint (a URL, `ip:port`, or bare ip), it returns a
  barebones pi `models.json` carrying exactly ONE local provider pointed at that
  endpoint. This replaces the old `import`-from-host-models.json flow as the source
  of the seed provider (used by `init` / seed-if-fresh to seed each machine home).

  - The endpoint is normalised with the existing `hostPortKey` helper (drops
    scheme / path / `user:pass@`, lowercases), so every endpoint form produces the
    same single-provider output.
  - It reads NO host pi `models.json`: no other provider, no paid API key, no
    session identity can leak into the seed (the anonymity hygiene the old `import`
    path preserved is now guaranteed by construction).
  - The generated provider uses a neutral, host-agnostic key (`LOCAL_PROVIDER_NAME`
    = `local`), the OpenAI-compatible completions dialect
    (`LOCAL_PROVIDER_API` = `openai-completions`) that local model servers
    overwhelmingly speak, a benign non-secret apiKey (`none`), and a
    `http://<host[:port]>/v1` baseUrl.

  This change is ADDITIVE: the legacy `import`-source symbols
  (`pickProviderForLlm` / `resolveSourceModelsPath`) and their tests are left in
  place (still read by `cli.ts`'s `import` path); their removal is owned by a later
  task.

- 6652498: Add the pure run-vs-start decision rule for kept (`netcage.managed`) containers
  to `src/anon-pi.ts`. For the exploratory `--keep` flow, decide whether a
  re-entered launch resumes an existing kept container (`netcage start`) or runs a
  fresh one (`netcage run` without `--rm`).

  - `keptContainerKey(intent)`: the launch-identity match key, derived ENTIRELY
    from the (machine, projects-root, project) identity (machine name +
    projects-root + `--mount` parent + the resolved container cwd, which encodes
    the project token and pi's conversation key). Excludes `--keep`/`--rm`, the
    forced-egress inputs, forwarded pi args, and the seed (see ADR-0002). anon-pi
    invents NO registry file: netcage's `netcage.managed` label IS the record.
  - `resolveRunVsStart(intent, listing)`: the pure decision. `--rm` (throwaway)
    ALWAYS resolves to a fresh `run` and never consults the listing; `--keep`
    resolves to `start` (with the matched container's ref) when a kept container
    whose key equals this launch's `keptContainerKey` is present, else `run`.
  - The netcage QUERY (asking netcage for its labelled containers) is an injected
    seam: the pure rule receives its RESULT (`KeptContainer[]`), so the decision
    is a pure function of (intent, listing) and unit-tested with fixture listings
    (present / absent / `--rm` short-circuit / match-key correctness). No real
    netcage/podman is invoked.

  The CLI that runs the real query and spawns `netcage start`/`run` is a later
  task.

- 34ec17a: Add the pure workspace-layout foundation for the machines + projects model.

  The anon-pi home now defaults to `~/.anon-pi/` (overridable by `ANON_PI_HOME`,
  no longer under `~/.config`). New pure resolvers in `src/anon-pi.ts`:
  machine/projects layout paths (`machineDir`, `machineHomeDir`, `machineJsonPath`,
  `builtinProjectsRoot`), `config.json`/`machine.json` parsers (`parseConfigJson`,
  `parseMachineJson`), and the load+merge resolvers with the decided precedence:
  projects-root `--mount` (later) > `ANON_PI_PROJECTS` > `machine.json.projects` >
  `config.json.projects` > built-in `~/.anon-pi/projects/`; proxy/llm env over
  config, with the proxy REQUIRED and fail-closed (verbatim guidance). This is
  additive: the legacy `buildRunPlan`/`import` seed + state paths still read the
  old `~/.config/anon-pi` layout and are retired by later tasks.

### Patch Changes

- 84e09f3: Polish + docs, resolving two filed observations:

  - `anon-pi init`'s proxy findings now show the host-wide process hint ONCE (as a
    general note) instead of gluing it onto every probed port line (including
    closed ports it was unrelated to). `formatProxyFindings` gained an optional
    host-wide `processNote` param; the per-finding rendering is kept for backward
    compatibility.
  - `anon-pi machine --help` (and `-h`) now reach the machine help (`MACHINE_HELP`)
    instead of the global help: the top-level `--help` intercept now excepts
    `machine` as well as `init` (the subcommands that own their own help).
  - Refreshed the stale top-of-file docblock in `src/anon-pi.ts` (it still
    described the retired 0.4.0 per-workdir model) and removed the now-dead
    `CONTAINER_WORKDIR` constant.
  - README: added a "Common tasks" quick-reference, a first-session walkthrough,
    and a Troubleshooting section; noted per-subcommand `--help`.

- 3fefd6d: Rewrite the README around the shipped **machines + projects** model and add a
  0.4.0 migration note.

  The README now documents the landed CLI surface (verified against `src/cli.ts` +
  the pure `HELP`): machines (image + persistent host home at `/root`), projects
  (folders under the projects root, mounted at `/projects/<name>`, the conversation
  key), `anon-pi init` onboarding, the bare-launch interactive **menu**, the
  `--shell` project-hopper (pi can't `cd` mid-session), the `--mount <parent>`
  host-parent caveat (`/work`), the throwaway-default (`--rm`) with `--keep` for a
  kept container, the `machine …` verbs and the `--delete-home` / `--delete-project`
  data verbs, env-vars-as-overrides, the `~/.anon-pi/` layout, and the
  forced-egress honesty (evidence via `netcage verify`'s exit IP, never a claim
  about the exit provider).

  A **Migrating from 0.4.0** section documents the breaking change for existing
  users: a bare positional is now a PROJECT (not a host path; host folders use
  `--mount`); `import` / `--fresh` / `--ephemeral` are removed (→ `init` /
  `--delete-home` + `--delete-project` / `--rm` + `--keep`); the old
  `~/.config/anon-pi/state/<slug>/` is NOT migrated (delete it); and the workspace
  moved to `~/.anon-pi/`.

  Adds a `readme-drift.test.ts` rung-1 guard that fails if the README re-introduces
  the retired 0.4.0 vocabulary or drops the landed surface.

- 6dbe0a4: Retire the orphaned legacy pure surface left over from the 0.4.0 per-workdir
  model, now that `cli.ts` reads none of it. Pure code + test deletion, no
  behaviour change.

  Removed from `src/anon-pi.ts` (all dead once `cli-launch-surface-grammar-a`
  rewrote the CLI onto the machines + projects resolvers): the five legacy
  functions `buildRunPlan` (old per-workdir shape), `stateAgentDir`,
  `resolveConfigSeed`, `pickProviderForLlm`, `resolveSourceModelsPath`; the dead
  `AnonPiEnv` fields `ephemeral` / `configSeed` / `sourceModels` (plus
  `piAgentDir`, orphaned with `resolveSourceModelsPath`) and their `envFromProcess`
  env-key mappings (`ANON_PI_EPHEMERAL` / `ANON_PI_CONFIG` / `ANON_PI_SOURCE_MODELS`
  / `PI_CODING_AGENT_DIR`); and the now-unreferenced supporting declarations
  (`RunPlan` interface, `ImportResult` interface, `legacyAnonPiHome`,
  `BENIGN_API_KEYS`, the `isTruthy` helper) that existed only to serve them.

  The corresponding `anon-pi.test.ts` describe blocks are deleted; the surviving
  surface (`resolveAnonPiHome`, `hostPortKey`, `pathSlug`, the new layout/config
  resolvers, `resolveRunPlan`, `generateModelsJson`) is kept untouched.

## 0.4.0

### Minor Changes

- c92f296: Add `anon-pi --fresh [WORKDIR]`: delete this workdir's persistent state home
  before launching, so the (possibly rebuilt) image's staged defaults and your
  imported `models.json` are re-seeded on this launch. Use it after rebuilding your
  image to pick up new extensions/config without hand-deleting the state dir.
  `--fresh` with `--ephemeral` is rejected (an ephemeral session is always fresh).

## 0.3.0

### Minor Changes

- 77f44f0: Make `ANON_PI_PROXY` required; remove the `socks5h://127.0.0.1:9050` default.
  anon-pi is an anonymity tool, so the proxy is the single most important input and
  must never be guessed: a silent default can anonymize through the wrong endpoint
  (or none) and fail confusingly deep in the jail. It now errors like
  `ANON_PI_IMAGE`/`ANON_PI_LLM` when unset, mirroring netcage, which itself refuses
  to run without `--proxy` (fail-closed). The error lists copy-paste `export` lines
  for the common proxies (Tor on `9050`, wireproxy/ssh -D on `1080`).
- e0eb4b1: Make anon-pi STATEFUL: persist pi's home across launches, with first-launch
  seeding (Model B + C).

  - anon-pi now mounts a persistent per-workdir host dir at the container's
    `~/.pi/agent`, so sessions, history, settings (your model choice), and any
    extensions you `pi install` all survive across launches. Re-running in the
    same folder resumes it. The state dir is `<ANON_PI_HOME>/state/<workdir>/agent`,
    named with pi's own readable path convention (not a hash).
  - First-launch seed-if-fresh: on a fresh home the image's staged defaults
    (`/opt/anon-pi-seed/agent`: extensions, `trust.json`) and your imported
    `models.json` are promoted in once and a `.anon-pi-seed` marker is stamped;
    thereafter pi owns the home and nothing is clobbered. Resolves the "changed my
    model / installed an extension and it forgot" and the repeated `fd` download.
  - `--ephemeral` / `ANON_PI_EPHEMERAL=1`: mount NO writable state. pi writes to
    the container's own `--rm` layer, destroyed on exit, so nothing writable ever
    touches a host path, there is no cleanup, and nothing is left behind even on a
    crash. (Only the read-only models.json seed is mounted.)
  - Images now install extensions + config into the STAGING dir
    (`PI_CODING_AGENT_DIR=/opt/anon-pi-seed/agent pi install ...`), not
    `~/.pi/agent` (which is the mount and would be shadowed). Updated `Dockerfile.pi`
    and `examples/Dockerfile.pi-webveil`.

### Patch Changes

- 7bcdf33: Accept a URL-form `ANON_PI_LLM`. netcage's `--allow-direct` wants a bare
  `IP[:port]`/CIDR, but users naturally set `ANON_PI_LLM` to a URL like
  `http://192.168.1.150:8080`. anon-pi now strips the scheme/path (the same
  normalization `import` already uses) before passing it to `--allow-direct`, so a
  URL, an `ip:port`, or a bare IP all work.
- 7dcf96a: The missing-`ANON_PI_IMAGE` error now also offers a copy-paste build for the
  fuller `examples/Dockerfile.pi-webveil` (pi + the pi-webveil extension + a local
  SearXNG), alongside the simple `Dockerfile.pi`, each resolved to its real shipped
  path.

## 0.2.0

### Minor Changes

- 76a99a0: Add `anon-pi import` and reshape the seed model so image-installed extensions
  survive.

  - `anon-pi import` generates the seed from your local model: it reads your host
    `~/.pi/agent/models.json`, picks the provider whose `baseUrl` serves
    `ANON_PI_LLM`, and writes just that provider to `<ANON_PI_CONFIG>/models.json`.
    No other provider's API keys, no sessions, no identity. Errors on no match,
    warns on a real-looking `apiKey`, refuses to overwrite without `--force`.
  - The seed is now just `models.json`. anon-pi mounts it read-only and **copies**
    it into the container's own `~/.pi/agent` at start (instead of mounting a
    whole config dir as `PI_CODING_AGENT_DIR`), so extensions/skills baked into the
    image are no longer shadowed. pi auto-selects the local model (no default
    needed). Removed `ANON_PI_AGENT_MOUNT` and the per-session seed copy.
  - README + `Dockerfile.pi`: document that extensions, skills, and their services
    (e.g. `pi-webveil` + searxng) belong in the image, installed via `pi install`.
  - Ship a worked `examples/Dockerfile.pi-webveil`: pi + pi-webveil + a local
    SearXNG over a Unix socket (http-socket, json+limiter:false, `unix:` baseUrl,
    `egress: direct`), started by an entrypoint that then execs anon-pi's command.
    It documents why the usual local-SearXNG anonymity caveat does not apply
    in-jail (netcage forces every process's egress through the proxy).

### Patch Changes

- 0f8f76c: Make the missing-`ANON_PI_IMAGE` error copy-pasteable. The previous version
  printed an indented `Dockerfile.pi` heredoc, so pasting it baked leading spaces
  into the file and broke the `EOF` terminator. Now the error points at the
  `Dockerfile.pi` that ships with the package (resolved to its real absolute path)
  and emits a flush-left `podman build` + `export` you can paste as-is.

## 0.1.1

### Patch Changes

- 8ad9f14: Make the missing-`ANON_PI_IMAGE` error actionable: instead of a one-line dead
  end, it now prints a ready-to-build `Dockerfile.pi` recipe (the upstream pattern
  that installs `@earendil-works/pi-coding-agent`) plus the `podman build` and
  `export ANON_PI_IMAGE` commands, and points at the shipped `Dockerfile.pi` /
  README. `--help` gains a matching hint.

## 0.1.0

### Minor Changes

- e99c7cf: Initial release. anon-pi is a thin, opinionated launcher over `netcage run` that
  starts pi with all web/DNS egress forced through a socks5h proxy (fail-closed),
  one direct hole to a local model on the LAN, and a per-workdir seeded pi config
  on the host. Requires `netcage` on PATH and an `ANON_PI_IMAGE` with `pi` on it
  (a `Dockerfile.pi` is included).
