# anon-pi

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
