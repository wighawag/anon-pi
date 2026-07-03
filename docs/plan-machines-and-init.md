# Plan: machines + projects (anon-pi workspace model, netcage-v0.4.0 edition)

Status: PLANNED (not yet implemented). Supersedes the current per-workdir stateful
model (0.4.0) AND the earlier machines+init draft. Ships as a **minor** with a
breaking CLI change + a README migration note.

This revision is written against **netcage v0.4.0 as shipped** (kept containers +
`netcage start` + management verbs + `--rm` = ephemeral). The earlier draft hedged
("if the netcage lifecycle PRD lands, this thins" - section 13b). It landed. This
rewrite bakes that in and is significantly simpler.

## 0. The anchor (what actually drove the design)

**The persistent, inspectable state is a HOST directory (the machine home). The
container is disposable.** Everything valuable - shell config, pi config,
extensions, pi conversations, and all project work - lives in the machine's home
dir on the host, bind-mounted into the jail. So a launch is (almost always) a
FRESH `netcage run` with that home mounted; nothing of value lives in the
container, so nothing is lost when it goes.

Two facts shaped every decision:

- **pi keys a conversation by its launch cwd** (pi's session-manager slugs the
  cwd). You cannot start pi and `cd` to another project mid-session; the folder
  IS the session key. => "switch project" means "launch pi with a different cwd",
  which is why the project-hopping surface is a SHELL (spawn a per-project pi from
  it), not a long-lived roaming pi.
- **A container's mount set is fixed at create (OCI/podman).** => you never
  "remount" a running box. We sidestep this entirely: ONE mount (the home, which
  contains `~/projects/*`), never changed; a different project is just a different
  cwd, a different host folder is `--mount`.

## 1. Concepts

- **Machine** = an **image + a persistent host home** (`$HOME`: shell config, pi
  config + extensions, and pi conversations). A named, durable, anonymized
  workstation. Machines own their image; a project needing a different image runs
  on a different machine (no image/home mismatch possible by construction).
- **Project** = a **folder inside the machine home** (`~/projects/<name>`). Not a
  host-folder binding, not a first-class isolation unit - just a directory you run
  pi in. Its conversation is keyed by its cwd (`/root/projects/<name>`).
- **Global config** = proxy + local-model endpoint + default machine. Set by
  `anon-pi init`. Not tied to a machine.
- **Launch** = mount the machine's home as `$HOME` -> run a **shell** (sit on the
  machine) or **pi in a project** (focused), jailed via netcage.

One machine concept. No stable-vs-exploratory type: the SAME machine is
throwaway-this-run or kept-and-resumable depending on `--rm` at launch (section 6).

## 2. Layout

```
~/.config/anon-pi/                 (<anon-pi-home>, from ANON_PI_HOME / XDG)
  config.json                      # { proxy, llm, defaultMachine }
  machines/
    default/
      machine.json                 # { "image": "<ref>" }
      home/                        # THE persistent $HOME for this machine (mounted at /root)
        .bashrc .gitconfig ...
        .pi/agent/{extensions,models.json,trust.json,sessions/,...}
        projects/
          <name>/                  # a project = a folder here; pi cwd = /root/projects/<name>
        .anon-pi-seed              # seed-version marker
    webveil/
      machine.json
      home/
```

Notes:
- The **whole `home/` is ONE bind-mount** (`-v machines/<M>/home:/root`).
  `~/projects/*` lives inside it, so all projects are reachable in a shell and
  conversations (`~/.pi/agent/sessions/`) are shared per machine. New project =
  `mkdir home/projects/<name>` on the host (appears live in the jail). No remount,
  ever.
- `models.json` is derived from the global `llm` endpoint and seeded into each
  machine's `home/.pi/agent/` on first launch.
- Conversations are per-machine (their home) AND per-project (keyed by
  `/root/projects/<name>` cwd). A different machine => different home => different
  conversations (expected).

## 3. config.json

```json
{
  "proxy": "socks5h://127.0.0.1:1080",
  "llm": "192.168.1.150:8080",
  "defaultMachine": "default"
}
```

- `ANON_PI_PROXY`, `ANON_PI_LLM` remain as OVERRIDES of config (env wins). If
  neither config nor env has the proxy, fail-closed (the proxy is never guessed -
  it is what anonymizes).

## 4. `anon-pi init` (onboarding; replaces `import` and env-as-primary)

Interactive, RE-RUNNABLE (doubles as reconfigure; shows current values
pre-filled; never destroys machines/homes). Flow:

1. **Proxy**: probe common SOCKS ports (9050 Tor, 9150 Tor Browser, 1080
   wireproxy/generic), CONFIRM each is really SOCKS5 via a minimal handshake,
   present findings to CHOOSE (or enter host:port). Weak process hints only ("a
   `tor` process is running -> likely Tor"); NEVER claim the exit provider (a
   SOCKS proxy does not announce Mullvad/Proton; a false label would be a
   dangerous lie for an anonymity tool). VERIFY: run `netcage verify --proxy
   socks5h://<chosen>` and show the exit IP (proof it is NOT the host IP). User
   confirms on evidence.
2. **Local model endpoint**: ask for `host:port` (e.g. `192.168.1.150:8080`);
   probe reachability. Generates the models.json provider from the endpoint (this
   replaces `import`).
3. **Default machine image**: menu from shipped Dockerfiles: `[1] basic pi
   (Dockerfile.pi)  [2] pi + webveil/searxng (examples/Dockerfile.pi-webveil)
   [3] existing image ref  [4] skip`. Building runs `podman build`.
4. Write `config.json` and create the `default` machine.

`import` is DROPPED (init captures the endpoint directly).

## 5. Machines

```
anon-pi machine create <name> [--image <ref>]   # create; image from --image or prompt
anon-pi machine list                            # machines + their images
anon-pi machine set-image <name> <ref>          # RE-PIN the image + WARN only (no auto-reseed)
anon-pi machine rm <name> [--yes]               # delete machine (config + home). confirm.
```

- **`set-image`** just re-pins and WARNS ("the home's extensions/bin were built
  for the old image; run `pi install` again or `--delete-home` if they
  misbehave"). This is the ONE explicit place an image changes.
- A machine's `home/` is seeded on first launch (section 8).
- **Baking an exploratory machine into an image** is NOT an anon-pi verb; the
  user runs `netcage commit <container> <image-ref>` themselves (section 9).

## 6. Launch: the surface

Grammar A: **a bare positional is a PROJECT** (on the default machine); the
machine is chosen with `-m` (or is `default`).

```
anon-pi                              # MENU (arrow-select): projects -> pi | + new project | shell
anon-pi <project>                    # pi in ~/projects/<project>, exit pi -> back to HOST
anon-pi <project> [pi-args...]       # forward args to pi (headless/one-shot; no TTY needed)
anon-pi --shell [<project>]          # jailed SHELL (at ~, or cd'd into <project>) - the project-hopper
anon-pi -m <machine> [<project>]     # same, on <machine>
anon-pi --mount <parent> [<project>] # root at a HOST parent folder (section 7)
  [--rm]                             # throwaway this run (deleted on exit; home ALWAYS persists)
```

Resolution:
- **bare `anon-pi`** = the `default` machine, **MENU** (no default PROJECT). The
  menu lists the machine's `~/projects/*` (each -> pi), plus `+ new project...`
  (prompt name -> pi there) and `shell` (jailed shell at `~`). Selecting a project
  is identical to `anon-pi <project>`.
- **`anon-pi <project>`** = pi launched with cwd `/root/projects/<project>`
  (created if absent), on the default machine. Exit pi -> host.
- **`anon-pi <project> <pi-args...>`** = the extra args are forwarded to pi (so
  `anon-pi recon -p "..."` / a headless pi works). The container cmd becomes
  `... exec pi "$@"` with the args threaded through `netcage run ... pi <args>`.
- **`--shell [<project>]`** = a jailed bash instead of pi (at `~`, or cd'd into
  the project). This is how you "play with the machine" AND how you hop projects
  (pi can't cd; you `cd projects/x && pi` from here, per project).
- **`-m <machine>`** = choose the machine; bare `-m webveil` (no project) shows
  the menu for that machine.

Why bare = menu (not a default pi and not a bare shell): pi is per-project (its
session is its cwd) and there is no "default project", so bare `anon-pi` has no
single obvious cwd for pi. Rather than invent a magic default or silently drop
you in a shell, ASK: the menu shows your projects (pi is the top action, honoring
"anon-pi is for pi"), with `shell` as the escape for hopping/poking. The menu is a
pure HOST-side TUI (it reads the host `~/projects/*` dir; no jail runs until you
choose).

### No-TTY discipline

- **bare `anon-pi`** with no TTY: ERROR ("no TTY: pick a project, e.g.
  `anon-pi recon`, or run in an interactive terminal"). There is nothing sensible
  to fall back to - an interactive pi and a shell BOTH need a TTY (as does
  `netcage run -it`), so a silent fallback would just fail differently.
- **`anon-pi <project>`** (interactive pi): needs a TTY (pi/netcage enforce it).
- **`anon-pi <project> <pi-args...>`** (headless pi): does NOT require a TTY - the
  TTY requirement belongs to the MENU and to INTERACTIVE pi, not to anon-pi as a
  blanket rule. Forward the args and let pi decide.

### The menu (TUI)

Prefer a **hand-rolled, zero-dependency** arrow-key selector (raw-mode stdin:
up/down/enter/Ctrl-C, a `>` cursor + highlighted active row, restore the terminal
on exit) - a smaller supply-chain surface is on-brand for a security tool, and the
project list is short. Keep it isolated: the PURE module returns the choice list
(`{ projects: string[], canShell: true }`); `cli.ts` renders + selects + launches
(the only untested I/O). If the hand-rolled result is not clean, swap in a small,
well-regarded select prompt - it is a localized change (only `select()` moves).

## 7. `--mount` (host-parent-folder root)

```
anon-pi --mount <parent-path> [<project>]
```

Mirrors the machine surface, but rooted at a HOST folder instead of the machine's
internal `~/projects`:

- `anon-pi --mount ~/dev/anon-projects` -> mount that host dir at `/work`, get a
  SHELL there (or the MENU of its subfolders); all subfolders are reachable (the
  PARENT is mounted), pi anywhere.
- `anon-pi --mount ~/dev/anon-projects <p>` -> pi in `/work/<p>` (cwd), siblings
  still reachable.
- The machine **home is SHARED** (extensions/config/conversations come along):
  `netcage run -v <parent>:/work -v <machine-home>:/root -w /work[/<p>] <img>
  pi|bash`. Conversations keyed by the `/work/<p>` cwd (distinct per subfolder).
- `--mount` is the escape hatch for editing HOST files with host tools while
  jailed. It is a plain `netcage run` with an extra `-v` (a host path cannot be
  mounted into an existing frozen box, so `--mount` is always a fresh run - which
  is fine, a host mount is inherently per-occasion). `-m`/`--rm` apply.
- Reserved: the mount lands at `/work` (distinct from the home at `/root`), so it
  never collides with the machine's own `~/projects`.

## 8. First-launch seed (seed-if-fresh, marker-guarded)

On a fresh machine home (no `.anon-pi-seed` marker), the container run command
promotes into the persisted `$HOME`:
- the image's `/root` defaults (`.bashrc` etc.),
- the image's pi staging (`/opt/anon-pi-seed/agent`: extensions, trust.json) into
  `~/.pi/agent`,
- the generated `models.json` (from global `llm`) into `~/.pi/agent/models.json`,
then writes `.anon-pi-seed`. The whole `$HOME` is the mount, so seeding is scoped
to the home; do not clobber a non-fresh home. (Unchanged in spirit from 0.4.0;
now keyed per MACHINE home, not per workdir.)

## 9. Kept vs throwaway (`--rm`) and the exploratory loop

There is ONE machine concept; `--rm` decides the container's fate this run:

- **no `--rm` (default)**: `netcage run` leaves the tool + sidecar KEPT (stopped)
  on exit, labelled `netcage.managed`. The container FILESYSTEM survives - this is
  the "play with system tools, quit, re-enter" path. Re-enter with the SAME launch
  (anon-pi finds the kept container by label and `netcage start`s it instead of a
  fresh `run`). Note: for a normal pi/project session this is usually
  unnecessary (all state is in the home mount), so anon-pi MAY default project/pi
  launches to `--rm` and reserve kept containers for `--shell`/exploratory use -
  see Open (section 14).
- **`--rm`**: `netcage run --rm` removes both on exit - throwaway container, no
  residue. The machine HOME still persists (it is the host mount); only the
  container-side (system-level) changes are discarded.

**Exploratory machine loop** (the one flow that needs the container filesystem):
```
anon-pi --shell sandbox         # netcage run -it (kept) ... bash ; apt install ...
<quit>                          # container kept, apt state on its fs
anon-pi --shell sandbox         # anon-pi finds the kept container -> netcage start (fs intact)
netcage commit <tool> localhost/sandbox:latest   # bake it into an image (raw-ish; the user's call)
anon-pi machine set-image sandbox localhost/sandbox:latest   # now a reproducible machine
```
anon-pi tracks kept containers by the `netcage.managed` label (via `netcage ps` /
inspect) to decide run-vs-start; it does NOT invent its own registry file.

## 10. Data verbs

```
anon-pi --delete-home [<machine>]   # delete a machine's home (config + convos + shell env).
                                    # default: default machine. confirm [y/N], --yes, non-TTY abort.
anon-pi --delete-work <project>     # delete ~/projects/<project> AND its per-cwd pi sessions.
                                    # confirm/--yes.
```

## 11. Behavior table

| Action                  | project work (`~/projects/<p>`) | machine home (pi config + convos + shell) | container fs |
| ----------------------- | ------------------------------- | ------------------------------------------ | ------------ |
| `anon-pi <p>` (default) | persist (in home)               | persist                                    | throwaway* |
| `anon-pi <p> --rm`      | persist (in home)               | persist                                    | removed |
| `anon-pi --shell` kept  | persist (in home)               | persist                                    | KEPT (start to resume) |
| `--mount <parent> <p>`  | persist (host parent)           | persist (shared home)                      | throwaway* |
| `--delete-home [M]`     | untouched                       | M deleted (all projects on M lose convos)  | - |
| `--delete-work <p>`     | **deleted**                     | p's sessions deleted; rest of home kept    | - |
| `machine set-image M R` | untouched                       | re-pin only; warn; home untouched          | - |

\* "throwaway" vs "kept" per section 9 / the `--rm` decision.

## 12. Breaking change + migration

- `anon-pi ./recon` no longer mounts host `./recon`. A bare positional is a
  PROJECT (a folder in the machine home). Host folders use `--mount <path>`.
- `ANON_PI_IMAGE` is no longer the launch image; the machine's image is (it MAY
  remain an `init` default-image hint). `ANON_PI_PROXY`/`ANON_PI_LLM` become
  OVERRIDES of config.
- `import` is DROPPED (use `init`). `--fresh` is DROPPED (use `--delete-home` /
  `--delete-work`). `--ephemeral` is REPLACED by `--rm` (throwaway container;
  note the home still persists, unlike the old --ephemeral which had no writable
  state at all - a fresh-home throwaway is `--rm` on a machine whose home you then
  `--delete-home`, or a dedicated flag if we want the old "no host state at all"
  semantics back; see Open).
- Old 0.4.0 state (`~/.config/anon-pi/state/<slug>/agent`) is NOT migrated;
  document deleting it. New layout: `config.json` + `machines/` (+ `projects/`
  inside each machine home).
- README: rewrite around machines + projects + `init` + the menu; migration note.

## 13. Implementation checklist

Pure module (`src/anon-pi.ts`):
- config.json shape + load/merge with env overrides (proxy, llm, defaultMachine).
- Machine resolvers: machine dir, `machine.json` (image), machine home dir.
- Project resolvers: `~/projects/<name>` inside the home; name validation (reject
  `/ \ : .. leading-dot whitespace`; reserved `host` for the `--mount` namespace).
- Launch resolution -> a RunPlan: mode (menu | pi<project> | shell[project] |
  mount<parent>[project]), machine, cwd (`/root/projects/<p>` or `/root` or
  `/work[/<p>]`), the ONE home mount (`machines/<M>/home:/root`), optional
  `--mount` parent mount (`<parent>:/work`), `--rm` on/off, forwarded pi args,
  seed-if-fresh run cmd.
- The MENU CHOICE LIST (`{ projects, canShell, canNew }`) computed purely from the
  host `~/projects/*` listing (rendering/selection is in cli.ts).
- Run-vs-start decision: given the resolved machine/launch, whether a KEPT
  `netcage.managed` container already exists (so cli.ts calls `netcage start` vs
  `netcage run`). The QUERY (how to ask netcage) is impure; the DECISION rule is
  pure.
- models.json generation from the `llm` endpoint.
- container run cmd: seed-if-fresh + `exec pi "$@"` (forward args) OR `exec bash`.

CLI (`src/cli.ts`):
- Subcommands: `init`, `machine {create,list,set-image,rm}`, the launch path
  (default), data verbs `--delete-home`/`--delete-work`.
- Launch: parse grammar A (bare positional = project; `-m` = machine; `--shell`,
  `--mount <parent>`, `--rm`, forwarded pi args after the project); reserved-name
  guard; NAME vs `--mount` exclusivity; create dirs; run-vs-start (query netcage
  by label); spawn netcage with inherited stdio.
- MENU: hand-rolled raw-mode select over the pure choice list; no-TTY -> error.
- `init`: proxy probe + SOCKS5 handshake + findings + `netcage verify` + confirm;
  llm endpoint + probe; image menu from shipped Dockerfiles (+ build); write
  config + default machine. Re-runnable.
- Destructive verbs: confirm on TTY, abort non-TTY without `--yes`.
- Drop `import`, `--fresh`, `--ephemeral`(->`--rm`), the per-workdir slug state
  model, `ANON_PI_AGENT_MOUNT`/seed-mount remnants.

Images (`Dockerfile.pi`, `examples/Dockerfile.pi-webveil`):
- Staging dir unchanged (`/opt/anon-pi-seed/agent`).
- Ensure `/root` has base-image `.bashrc` etc. to seed from.
- Confirm the webveil entrypoint composes with the seed-if-fresh run cmd and the
  `/root/projects/<name>` (or `/work`) cwd.
- Ensure `~/projects/` is created (or created on seed) so a fresh machine has a
  place for projects.

Tests:
- config load + env-override precedence.
- machine create/list/set-image(warn)/rm; machine home seeding.
- launch resolution: bare -> menu choice list; `<project>` -> pi cwd
  `/root/projects/<p>`; `<project> args` -> forwarded to pi; `--shell [p]` -> bash
  cwd; `-m` -> machine; `--mount <parent> [p]` -> `/work[/p]` + shared home.
- the ONE home mount is always present; `--mount` adds exactly the parent mount.
- `--rm` on/off -> netcage `--rm` present/absent; run-vs-start DECISION rule
  (kept container present -> start).
- reserved `host`, NAME vs `--mount` exclusivity, name validation.
- no-TTY: bare -> error; `<project> args` -> allowed (no TTY needed).
- `--delete-home` / `--delete-work` (confirm/--yes/non-TTY abort; delete-work
  drops the project's per-cwd sessions).
- init: proxy detection presents findings but never labels the exit provider; the
  `netcage verify` step is invoked; models.json synthesized from the llm endpoint.
- menu choice list is computed correctly from a fixture `~/projects/*` (the pure
  part; the raw-mode rendering is not unit-tested).

README:
- Rewrite around machines + projects + init + the bare-menu; the `--shell`
  project-hopper (pi can't cd, so the shell is the hopper); the `--mount`
  host-parent caveat; proxy detection-then-verify honesty; the exploratory
  kept-container -> `netcage commit` loop; migration note; env vars as overrides.

## 14. Deferred / dropped / open

- **`--isolated`, `--fresh`, `import`, `.anon-pi-seed` image-marker + `--accept`,
  per-project machine binding, `switch-machine`, a `(machine,project)->container`
  registry file**: ALL DROPPED. One machine concept + projects-as-folders + the
  bare menu + run-vs-start-by-label make them unnecessary.
- **netcage `commit`**: a NEW netcage verb (staged as a netcage task,
  `commit-verb-snapshots-jailed-container-to-image`) closes the exploratory
  loop. anon-pi does NOT wrap it as its own `bake` verb (per decision); the user
  runs `netcage commit` + `machine set-image`.
- **Open - the `--rm` default for pi/project launches.** A normal pi session
  keeps all state in the home mount, so the container is disposable => defaulting
  project launches to `--rm` (no kept residue) is attractive; kept containers are
  really only wanted for the exploratory `--shell` flow. Decide: (a) default all
  launches to `--rm` except an explicit "keep" / the exploratory shell, or (b)
  default to kept and let `--rm` opt out. Leaning (a): kept containers are the
  exception (exploratory), throwaway is the norm (everything valuable is in the
  home).
- **Open - "no host state at all" mode.** Old `--ephemeral` mounted NO writable
  home (pi wrote only to the `--rm` layer). The new `--rm` still mounts the
  persistent home. If a fully-stateless throwaway is still wanted (a truly
  anonymous one-off with no home), keep a dedicated flag (e.g. `--ephemeral` =
  `--rm` + a THROWAWAY in-container home, no host home mount). Decide whether that
  use case survives.
- **Open - addressing a `--mount` target in data verbs.** `--delete-work` on a
  `--mount` subfolder: key it by the host path. Finalize when implementing.
- **Reviewer notes (preserved)**: (a) the design is a small workspace manager now;
  `machine` + the menu are the right structure, but watch for sprawl. (b) `init`
  proxy detection MUST stay honest (evidence via `netcage verify`, never a guessed
  provider label) or it undermines the tool's whole point.
```
