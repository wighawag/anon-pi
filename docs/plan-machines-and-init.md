# Plan: machines + init (anon-pi workspace model)

Status: PLANNED (not yet implemented). Supersedes the current per-workdir
stateful model (0.4.0) AND the earlier named-project draft. Ships as a **minor**
with a breaking CLI change + README migration note.

This is the build spec. It is fully nailed; implement top-to-bottom.

## 1. Concepts

- **Machine** = an **image + a persistent home** (`$HOME`: shell config, pi
  config, extensions, and pi conversations). A named, durable environment. You
  create machines, update their image (deliberately), and launch into them.
- **Project** = a **work folder** (the files you work on), mounted per-launch. A
  project is **bound to exactly one machine** (chosen at first launch, changed
  only by the explicit `switch-machine` verb).
- **Global config** = proxy + local-model endpoint + default machine. Set by
  `anon-pi init`. Not tied to a machine.
- **Launch** = resolve the project's machine -> mount that machine's home + the
  project's work folder -> run pi jailed via netcage.

Why this model: it separates the two things that fought each other. The home is
image-specific (extensions/`bin/fd` are compiled for an image), so it belongs to
a **machine** that owns its image. A project needing a different image just runs
on a different machine. No image/home mismatch is possible by construction, so
the old `.anon-pi-seed` image-marker + `--accept` machinery is gone.

## 2. Layout

```
~/.config/anon-pi/                 (<anon-pi-home>, from ANON_PI_HOME / XDG)
  config.json                      # { proxy, llm, defaultMachine }
  machines/
    default/
      machine.json                 # { "image": "<ref>" }
      home/                        # THE persistent $HOME for this machine
        .bashrc, .gitconfig, history,
        .pi/agent/{extensions,models.json,trust.json,sessions/,...}
        .anon-pi-seed              # marker: seed version (image is structural now)
    webveil/
      machine.json
      home/
  projects/
    <name>/
      project.json                 # { "machine": "<machine-name>" }
      work/                        # -> /work/<name>  (pi cwd; per-project sessions)
```

Notes:
- `models.json` is derived from the global `llm` endpoint and seeded into each
  machine's `home/.pi/agent/` on first launch (shared source, materialized per
  machine home).
- Conversations live in a machine's `home/.pi/agent/sessions/`, keyed by the
  container cwd `/work/<name>`, so they are per-project AND per-machine.

## 3. config.json

```json
{
  "proxy": "socks5h://127.0.0.1:1080",
  "llm": "192.168.1.150:8080",
  "defaultMachine": "default"
}
```

- `ANON_PI_PROXY`, `ANON_PI_LLM` remain as OVERRIDES of config (env wins), so
  power users / scripts can override without editing config. If neither config
  nor env has the proxy, fail-closed (unchanged discipline: the proxy is never
  guessed).

## 4. `anon-pi init` (onboarding; replaces `import` and env-as-primary)

Interactive, RE-RUNNABLE (doubles as reconfigure; shows current values
pre-filled; never destroys machines/homes). Flow:

1. **Proxy** (what anonymizes traffic):
   - Probe common SOCKS ports (9050 Tor, 9150 Tor Browser, 1080 wireproxy/generic)
     and CONFIRM each is really SOCKS5 via a minimal SOCKS5 handshake.
   - Present findings for the user to CHOOSE (or enter host:port). Weak hints
     only ("a `tor` process is running -> likely Tor"); NEVER claim the exit
     provider (a SOCKS proxy does not announce Mullvad/Proton; a false label
     would be a dangerous lie for an anonymity tool).
   - VERIFY the chosen proxy: run `netcage verify --proxy socks5h://<chosen>` and
     show the exit IP (proof it is NOT the host IP). User confirms on evidence.
2. **Local model endpoint** (the one direct hole): ask for `host:port`
   (e.g. `192.168.1.150:8080`); probe reachability. This replaces `import`:
   anon-pi generates the models.json provider from the endpoint.
3. **Default machine image**: offer a menu built from the shipped Dockerfiles:
   `[1] basic pi (Dockerfile.pi)  [2] pi + webveil/searxng
   (examples/Dockerfile.pi-webveil)  [3] existing image ref  [4] skip`.
   Building runs the `podman build` for the user.
4. Write `config.json` and create the `default` machine.

`import` is DROPPED (init captures the endpoint directly).

## 5. Machines

```
anon-pi machine create <name> [--image <ref>]   # create; image from --image or prompt
anon-pi machine list                            # list machines + their images
anon-pi machine set-image <name> <ref>          # RE-PIN the image + WARN only
anon-pi machine rm <name> [--yes]               # delete machine (config + home). confirm.
```

- **`set-image`** just re-pins and WARNS ("the home's extensions/bin were built
  for the old image; run `pi install` again or `--delete-home` if they
  misbehave"). No auto-reseed. This is the ONE explicit place an image changes,
  so no launch-time mismatch check is needed.
- A machine's `home/` is seeded on first launch (see section 8).

## 6. Projects + launch resolution

```
anon-pi [PROJECT] [--mount <path>] [--ephemeral] [-m <machine>]
```

- **Machine binding is a fixed property of a project**, chosen at FIRST launch,
  changed ONLY by `switch-machine`.
- **First launch of a project** (no machine bound yet):
  - TTY: PROMPT "Project '<name>' has no machine. Which? [default/webveil/...]"
    -> record in `project.json` -> launch.
  - `-m <machine>` given: use it as the binding (this is SETTING, not switching);
    print `associating machine "<m>" with project "<name>"`.
  - No TTY and no `-m`: FAIL asking for `-m`.
- **Subsequent launches**: `anon-pi <project>` uses the bound machine.
  - `-m <different>` on an already-bound project: **FAIL** -> "use
    `anon-pi switch-machine`". (`-m <same>` is a harmless no-op.)
- **Default project**: bare `anon-pi` = project `default` (scratch), same
  resolution (first launch prompts/`-m`; then bound).

`-m` is therefore NOT a launch modifier; it only SETS the binding on first
launch. Switching is a separate verb.

### switch-machine (deliberate, guarded)

```
anon-pi switch-machine <project> <machine> [--yes]
```

- Re-associates only; does NOT launch (you then `anon-pi <project>`).
- WARNS: this changes the environment AND the conversation history; the old
  machine's history for this project is PRESERVED (not migrated), resumable if
  you switch back.
- Confirm `[y/N]` (meaningful change), `--yes` bypass, abort non-TTY without
  `--yes`.

## 7. `--mount` (single-folder host escape hatch)

```
anon-pi --mount <path> [-m <machine> on first use]
```

- Mounts ONLY `<path>` at `/work/host/<abs path>`, cwd there. No other host
  access; different mounts never see each other (they share only the machine
  home). Path REQUIRED. Mutually exclusive with a PROJECT name.
- A `--mount` target is treated like a project for machine-binding + sessions,
  keyed by its host path. First use binds a machine (prompt/`-m`); later uses
  reuse it; switching via `switch-machine <the-path> <machine>` (or a dedicated
  form). (Detail to finalize in impl: how a mount path is addressed by
  switch-machine; simplest is to treat the abs path as the project key.)
- `host` is a RESERVED project name (it is the `--mount` container namespace).

## 8. First-launch seed (seed-if-fresh, marker-guarded)

On a fresh machine home (no `.anon-pi-seed` marker), the container run command
promotes into the persisted `$HOME`:
- the image's `/root` defaults (`.bashrc` etc. from the base image),
- the image's pi staging (`/opt/anon-pi-seed/agent`: extensions, trust.json)
  into `~/.pi/agent`,
- the generated `models.json` (from global `llm`) into `~/.pi/agent/models.json`,
then writes `.anon-pi-seed` (seed version). The whole `$HOME` is the mount, so
seeding is scoped to the whole home; do not clobber a non-fresh home.

## 9. Data verbs

```
anon-pi --delete-home [<machine>]   # delete a machine's home (config + convos +
                                    # shell env). Default: current/default machine.
                                    # confirm [y/N], --yes, abort non-TTY without --yes.
anon-pi --delete-work <project>     # delete the project's work/ AND its per-machine
                                    # pi sessions (anon-pi understands pi's per-cwd
                                    # session layout). confirm/--yes.
```

## 10. --ephemeral (unchanged property)

`anon-pi --ephemeral [PROJECT]` mounts NO writable home; pi writes to the
container's `--rm` layer, discarded on exit; no host state. (Same as 0.4.0.)
Still needs a machine (for the image); resolves like a launch but seeds a fresh
throwaway home in-container.

## 11. Behavior table

| Action                 | project work | machine home (pi config + convos + shell) |
| ---------------------- | ------------ | ------------------------------------------ |
| normal launch          | persist      | persist                                    |
| `--ephemeral`          | none         | none (container --rm layer)                |
| `--delete-home [M]`    | untouched    | M deleted (all projects on M lose convos)  |
| `--delete-work P`      | **deleted**  | P's sessions deleted; rest of home kept    |
| `switch-machine P M`   | untouched    | P now runs on M (old machine's P history kept) |
| `machine set-image M R`| untouched    | re-pin only; warn; home untouched          |

## 12. Breaking change + migration

- `anon-pi ./recon` no longer mounts host `./recon`. `PROJECT` is a project name;
  host folders use `--mount <path>`.
- `ANON_PI_IMAGE` is no longer the launch image; the machine's image is. It MAY
  remain as the `init` default-image hint. `ANON_PI_PROXY`/`ANON_PI_LLM` become
  overrides of config.
- `import` is dropped (use `init`).
- Old 0.4.0 state (`~/.config/anon-pi/state/<slug>/agent`) is NOT migrated;
  document deleting it. New layout: `config.json` + `machines/` + `projects/`.
- README: rewrite around machines + projects + `init`; migration note.

## 13. Implementation checklist

Pure module (`src/anon-pi.ts`):
- config.json shape + load/merge with env overrides (proxy, llm, defaultMachine).
- Machine resolvers: machine dir, `machine.json` (image), machine home dir.
- Project resolvers: project dir, `project.json` (bound machine), work dir;
  name validation (+ reserved `host`, reject `/ \ : .. leading-dot whitespace`).
- Launch resolution: project -> bound machine, or first-launch (needs machine);
  `-m` semantics (set on first launch; error if differs on bound); `--mount`
  path -> `/work/host/<abs>` container path + its project-key.
- RunPlan: mount machine home at /root (or ephemeral none), work mount (named ->
  /work/<name>, or /work/host/<abs>), models.json seed mount, container cwd,
  seed-if-fresh run cmd (version marker; seeds $HOME + pi staging + models.json).
- models.json generation from the `llm` endpoint (reuse pickProvider/hostPortKey
  ideas; but now we SYNTHESIZE a provider from host:port rather than scrape).

CLI (`src/cli.ts`):
- Subcommands: `init`, `machine {create,list,set-image,rm}`, `switch-machine`,
  and the launch path (default). Data verbs `--delete-home`, `--delete-work`.
- `init`: proxy probe + SOCKS5 handshake + findings + `netcage verify` + confirm;
  llm endpoint + probe; image menu from shipped Dockerfiles (+ build); write
  config + default machine. Re-runnable (edit existing).
- Launch: resolve machine (bound / first-launch prompt / `-m`), reserved-name
  guard, NAME vs `--mount` exclusivity, create dirs, spawn netcage.
- `switch-machine`: re-bind only, warn + confirm/`--yes`, no launch.
- Destructive verbs: confirm on TTY, abort non-TTY without `--yes`.
- Drop `import`, `--fresh` (superseded), `--isolated` (deferred), the per-workdir
  slug state model, `ANON_PI_AGENT_MOUNT`/seed-mount remnants.

Images (`Dockerfile.pi`, `examples/Dockerfile.pi-webveil`):
- Staging dir unchanged (`/opt/anon-pi-seed/agent`).
- Ensure `/root` has the base-image `.bashrc` etc. to seed from (bookworm-slim
  ships one; confirm or add a minimal one).
- Confirm webveil entrypoint (start searxng, then `exec "$@"`) composes with the
  seed-if-fresh run cmd and `/work/<name>` cwd.

Tests:
- config load + env override precedence.
- machine create/list/set-image(warn)/rm; machine home seeding.
- project first-launch binding (prompt/`-m`/no-TTY-fail); `-m` on bound -> error.
- switch-machine re-binds only + confirm/--yes + non-TTY abort.
- launch mounts: home at /root, work at /work/<name> or /work/host/<abs>.
- reserved `host`, NAME vs --mount exclusivity, name validation.
- --ephemeral: no writable home mount (unchanged property).
- --delete-home / --delete-work (confirm/--yes/non-TTY abort; delete-work drops
  the project's per-cwd sessions).
- init: proxy detection presents findings but never labels the exit provider;
  the verify step is invoked; models.json synthesized from llm endpoint.

README:
- Rewrite: machines + projects + init; the `--mount` "one folder only" caveat;
  proxy detection-then-verify honesty; migration note; env vars as overrides.

## 13b. Dependency: netcage lifecycle (may thin this plan)

There is a proposed netcage PRD, `podman-fidelity-and-lifecycle` (in the netcage
repo, `work/prds/proposed/`), to split jail teardown (sidecar, always) from
tool-container lifecycle (podman `--rm` semantics) and add named/reusable jailed
containers + a jail-aware `netcage start`. If that lands, a **machine** becomes a
**netcage environment** (a named, reusable, jailed container with persistent
state), and THIS plan THINS: anon-pi would provide only the pi seed
(extensions/models/trust), the LLM/proxy config + `init`, and the project<->
machine binding, and CONSUME netcage machines instead of orchestrating
persistence via volume-mounts-over-a-throwaway-container. Revisit sections 2, 5,
8, 10 once the netcage lifecycle change is decided.

## 14. Deferred / dropped / open

- **`--isolated`**: DROPPED. Machines are the isolation unit; projects bind to one
  machine. No separate per-project home concept needed.
- **`--fresh`, `import`, `.anon-pi-seed` image-marker + `--accept`**: DROPPED
  (superseded by machines / init / structural image).
- **Proxy provider labels**: intentionally NOT claimed. Only port + SOCKS5
  confirmation + weak process hints + a real `verify`.
- **Open (impl detail)**: how `switch-machine` / `--delete-work` address a
  `--mount` target (keyed by abs path). Simplest: the abs path IS the project
  key; finalize when implementing `--mount`.
- **Open (future)**: `machine set-image` could optionally offer to re-`pi install`
  the recorded extensions for the new image (a guided re-seed). Not v1.
- **Reviewer notes (preserved)**: (a) the design has grown from "thin launcher"
  to a small workspace manager; the `machine`/`switch-machine` subcommands are
  the right structure for that, but keep an eye on further sprawl. (b) `init`
  proxy detection MUST stay honest (evidence via verify, never a guessed
  provider label) or it undermines the tool's whole point.
