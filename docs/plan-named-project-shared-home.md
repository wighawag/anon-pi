# Plan: named-project + shared-home workspace model

Status: PLANNED (not yet implemented). This supersedes the current per-workdir
stateful model (0.4.0). Ships as a **minor** with a breaking CLI change + README
migration note.

## Motivation

The current model mounts the host cwd at `/work` and keys session state by the
host path. That has two problems for an anonymity tool:

1. It reaches into the user's real filesystem (whatever cwd they stood in) and
   mounts it into the jail; the real project path even leaks into the session
   slug.
2. "Stateful session" invites the mental model "this is my machine", but only
   the one cwd folder is present, not the rest of the filesystem. Sharing the
   home makes that false promise worse (home persists, filesystem does not).

Fix: anon-pi owns its own workspace under the anon-pi home. Projects are
addressed **by name**, decoupled from cwd. The persistent `$HOME` (shell + pi
config + conversations) is shared across projects. Host filesystem access is an
explicit, single-folder `--mount` escape hatch that never pretends to be "your
machine".

## Model

- **Named projects**, decoupled from cwd. `anon-pi recon` from anywhere -> same
  files + conversation + shell env.
- **Shared `$HOME`** by default (one anon-pi home for shell + pi config +
  extensions + all conversations). Configure once, everywhere.
- **Per-project cwd `/work/<name>`** so pi's session slug (which pi keys by cwd)
  is per-project -> conversations resume per project even with a shared home.
- **`--mount <path>`**: deliberate single-folder host access at
  `/work/host/<path>`. That folder ONLY; isolated from everything else and from
  other mounts. The honest opposite of "it's my machine".
- **`$HOME` fully persisted** (subsumes the earlier `.bashrc` request): `.bashrc`,
  `.gitconfig`, shell history, `~/.pi/agent` (config + conversations) all come
  back.

## Layout

```
~/.config/anon-pi/                 (<anon-pi-home>, from ANON_PI_HOME / XDG)
  agent/models.json                # canonical seed from `anon-pi import`
  home/                            # SHARED container $HOME (default), persistent
    .anon-pi-seed                  # marker: seed version + image ref it was seeded with
    .bashrc, .gitconfig, history, .pi/agent/{extensions,models.json,trust.json,sessions/,...}
  projects/<name>/work/            # -> /work/<name>  (pi cwd; per-project sessions)
```

Note: no `projects/<name>/home/` in v1 (`--isolated` is deferred, see below).

## Commands

```
anon-pi [NAME]              # project NAME (default "default"), SHARED home,
                            # cwd /work/<name>. Files + $HOME + pi config +
                            # conversations all persist and resume.

anon-pi --mount <path>      # mount a real host folder at /work/host/<path>,
                            # cwd there. Shared home + pi config. THAT FOLDER
                            # ONLY (no other host access, isolated from other
                            # mounts). Path REQUIRED. Mutually exclusive with NAME.

anon-pi --ephemeral [NAME]  # no persistence (container --rm layer; no host state)

anon-pi --delete-home       # delete the WHOLE shared home (config, conversations,
                            # shell env). Destructive -> [y/N], --yes bypass,
                            # abort in non-TTY without --yes.

anon-pi --delete-work NAME  # delete project NAME's work/ AND its pi sessions
                            # (anon-pi understands pi's per-cwd session layout).
                            # Destructive -> [y/N], --yes bypass, abort non-TTY.

anon-pi import [--force]    # write the canonical seed models.json (unchanged)
```

- **Default project `default`** (bare `anon-pi`). There is NO bare-`anon-pi`
  auto-cwd mount: cwd/host access is ONLY via explicit `--mount <path>`. This is
  deliberate (auto-cwd re-creates the "it's my machine" false expectation).
- No `--reset-home` (removed as fuzzy; use `--delete-home` for a full reset).

## Locked decisions

1. **Image mismatch -> FAIL (not prompt, not warn).** On launch, if
   `ANON_PI_IMAGE` differs from the image ref recorded in the home's
   `.anon-pi-seed` marker, anon-pi errors and tells the user to re-run with
   **`--accept`**. `--accept` proceeds AND updates the recorded image ref; it does
   NOT auto-reseed (the home's extensions/bin may have been built for the old
   image; the user resets by hand / `--delete-home` if needed). No interactive
   prompt (avoids TTY/piping hangs).
   (Reviewer note: the implementer flagged a preference for warn-and-proceed here
   since this is a compatibility hint, not a leak; the owner chose FAIL. Build
   FAIL.)

2. **Per-project conversations:** cwd is `/work/<name>` (or `/work/host/<path>`
   for `--mount`), so pi's session slug is per-project/per-mount even under the
   shared home.

3. **`--mount` is single-folder + isolated:** mounts only `<path>` at
   `/work/host/<path>`. No access to anything else on the host, and different
   mounts never see each other (different work dir + session slug; they share
   only the home). Path required; bare `anon-pi` does NOT mount cwd.

4. **Reserved names:** `host` is rejected as a project NAME (it is the `--mount`
   namespace at `/work/host/...`). Also reject names containing `/`, `\`, `:`,
   `..`, leading `.`, or whitespace (path-safety; names map to a `projects/<name>`
   dir).

5. **Destructive verbs** (`--delete-home`, `--delete-work`): confirm `[y/N]` on a
   TTY; abort in non-TTY unless `--yes`.

## Mounts per launch

- `-v <home>/home : /root` (shared `$HOME`)
- named: `-v <home>/projects/<name>/work : /work/<name>` (cwd `/work/<name>`)
- `--mount <path>`: `-v <abs path> : /work/host/<abs path>` (cwd there)
- `-v <home>/agent/models.json : <seed path>:ro` (first-launch seed), if present
- `--ephemeral`: NO writable `-v` for the home; pi writes to the container's
  `--rm` layer (unchanged from 0.4.0's ephemeral).

## First-launch seed (seed-if-fresh, marker-guarded)

On a fresh shared home (no `.anon-pi-seed` marker), the container run command
promotes:
- the image's `/root` defaults (`.bashrc` etc. from the base image) into the
  persisted `$HOME`,
- the image's pi staging (`/opt/anon-pi-seed/agent`: extensions, trust.json)
  into `~/.pi/agent`,
- the mounted canonical `models.json` into `~/.pi/agent/models.json`,
then writes `.anon-pi-seed` holding the seed version AND the image ref (the
image ref powers the mismatch check in decision #1).

Because the whole `$HOME` is now the mount (not just `~/.pi/agent`), seeding is
scoped to the whole home. Take care not to clobber a non-fresh home.

## Behavior table

| Action           | work            | ~/.pi/agent (config + sessions) | rest of $HOME |
| ---------------- | --------------- | ------------------------------- | ------------- |
| normal launch    | persist         | persist                         | persist       |
| `--ephemeral`    | none            | none                            | none          |
| `--delete-home`  | untouched       | deleted                         | deleted       |
| `--delete-work N`| **deleted**     | N's sessions **deleted**        | untouched     |

## Deferred (NOT in this change)

- **`--isolated`** (per-project private home). No concrete use yet; adds a second
  home layout + scoping questions for the delete verbs. Add when a real need
  appears. Design hook: `projects/<name>/home/` mounted at `/root` instead of the
  shared `home/`.

## Breaking change + migration

- `anon-pi ./recon` no longer mounts the host folder `./recon`. `NAME` is now an
  anon-pi project name. Host-folder use moves to `--mount <path>`.
- Existing 0.4.0 state (`~/.config/anon-pi/state/<slug>/agent`) is NOT migrated;
  document that old sessions can be deleted, and that the new home lives at
  `~/.config/anon-pi/home/` + `~/.config/anon-pi/projects/`.
- README: add a "Workspaces" section explaining named projects vs `--mount`, the
  shared home, and the migration note. Update the env table + examples.

## Implementation checklist

Pure module (`src/anon-pi.ts`):
- New layout resolvers: shared home dir, `projects/<name>/work`, name validation
  (+ reserved `host`), `--mount` path -> `/work/host/<abs>` container path.
- RunPlan: mount `$HOME` (or ephemeral none), work mount (named or `--mount`),
  models.json seed mount, container cwd, seed-if-fresh run cmd stamping version +
  image ref.
- Image-mismatch check helper (reads the marker's image ref; the actual read is
  cli-side fs, so expose a pure "does X differ from Y -> error text" seam).
- Drop the per-workdir `state/<slug>` model + `stateAgentDir`/`pathSlug` usage
  for state (pathSlug may still be handy for `--mount` session keying; pi keys by
  cwd so the container cwd is what matters).

CLI (`src/cli.ts`):
- Parse: optional NAME positional; flags `--mount <path>`, `--ephemeral`,
  `--isolated` (reject: deferred, clear message), `--delete-home`,
  `--delete-work <name>`, `--accept`, `--yes`. Reject NAME + `--mount` together.
- Reserved/invalid name guard.
- Image-mismatch: read marker, compare to ANON_PI_IMAGE, FAIL unless `--accept`;
  on `--accept` update the recorded ref.
- Destructive verbs: confirm on TTY, abort non-TTY without `--yes`.
- Create dirs, mount, spawn netcage (unchanged handoff).

Images (`Dockerfile.pi`, `examples/Dockerfile.pi-webveil`):
- Staging dir unchanged (`/opt/anon-pi-seed/agent`).
- Ensure `.bashrc` etc. exist in the image `/root` to seed from (base image
  provides them; confirm bookworm-slim ships a root `.bashrc` or add a minimal
  one).
- Confirm the webveil entrypoint (starts searxng, then `exec "$@"`) still
  composes with the new seed-if-fresh run cmd and `/work/<name>` cwd.

Tests:
- Name validation + reserved `host` + NAME/`--mount` exclusivity.
- Mount composition: named -> `/work/<name>`; `--mount` -> `/work/host/<abs>`.
- Seed-if-fresh run cmd stamps version + image ref; mismatch text.
- Ephemeral -> no writable home mount (unchanged property).
- CLI-spawn tests for `--delete-home` / `--delete-work` (confirm + `--yes` +
  non-TTY abort), image-mismatch FAIL + `--accept`.

README:
- Workspaces section, migration note, updated env table + examples + `--mount`
  "one folder only" caveat.

## Open follow-ups (post-merge, optional)

- `--isolated` when a real need appears.
- Possibly a subcommand structure (`anon-pi project rm`, ...) if the flag set
  keeps growing (the implementer flagged verb sprawl).
- Reconsider image-mismatch FAIL vs WARN after living with it.
