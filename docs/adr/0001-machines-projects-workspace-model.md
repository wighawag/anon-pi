# Machines + projects workspace model (built on netcage v0.4.0)

## Context

anon-pi 0.4.0 launched pi as `anon-pi [WORKDIR]`: a per-workdir throwaway
`netcage run --rm` with a state home keyed to the workdir slug
(`~/.config/anon-pi/state/<workdir-slug>/agent`). This duplicated pi config +
extensions per workdir, had no notion of a durable named environment, and
predated netcage v0.4.0's container lifecycle (kept containers, `netcage start`,
`--rm`, the `netcage.managed` label). See `work/prds/tasked/machines-and-projects-workspace.md`.

## Decision

Rework anon-pi into a **machines + projects** workspace, built ENTIRELY on
netcage v0.4.0 as shipped (no netcage change required). The load-bearing
architectural decisions:

- **The persistent, inspectable state is a HOST directory (the machine home); the
  container is disposable.** A **machine** = an image + a persistent host home
  (`~/.anon-pi/machines/<M>/home`, bind-mounted at `/root`), holding shell config,
  pi config + extensions, and pi conversations. All valuable state lives in the
  host home, so a launch can be a fresh `netcage run` that loses nothing when the
  container goes.

- **Two invariant container mounts, always: `/root` (machine home) and
  `/projects` (projects root).** Nothing else changes between launches: a
  different project is just a different cwd; a different host root is `--mount`
  (which adds exactly one parent mount at a distinct `/work`). This sidesteps
  podman's mount-immutability entirely: we never remount a running box. Chosen
  over per-project remounting (impossible on a live container) and over a
  per-workdir mount set (the 0.4.0 model, which forced config duplication).

- **Throwaway (`--rm`) is the DEFAULT; `--keep` is the opt-in kept-container
  path.** Because everything valuable is in the host home, a normal pi/project
  session's container is disposable, so the default leaves no residue. `--keep`
  is reserved for the exploratory "apt install, quit, re-enter" flow, where the
  container FILESYSTEM must survive; anon-pi finds the kept container by netcage's
  `netcage.managed` label and `netcage start`s it. We rejected defaulting to kept
  (residue for the common case) and rejected an anon-pi-owned `(machine,project)→
  container` registry file (netcage's label IS the record).

- **Files are global by default; conversations are per-machine.** The projects
  root is GLOBAL (`~/.anon-pi/projects/`, shared across machines), so the same
  project folder is usable from more than one machine; but each machine keeps its
  OWN pi history in its home, keyed by the `/projects/<name>` cwd. Per-machine
  "used on" is DERIVED from the presence of session dirs — no marker file. This
  lets a user work the same code with a fresh anonymized environment/perspective.

- **The forced-egress invariant holds on EVERY path** (menu, pi, shell, mount,
  keep, rm): all web/DNS egress through the socks5h proxy, fail-closed, with the
  one direct hole for the local model. anon-pi never weakens netcage's invariant;
  the proxy is REQUIRED and never guessed.

- **Honest onboarding (`anon-pi init`).** Proxy detection presents evidence
  (ports, a SOCKS5 handshake, a real `netcage verify` exit IP) and weak process
  hints only — it MUST NEVER claim/label the exit provider. A SOCKS proxy does not
  announce Mullvad/Proton; a false label would be a dangerous lie for an anonymity
  tool.

- **Pure/impure split preserved.** The pure module (`src/anon-pi.ts`) computes the
  RunPlan, the menu choice-list, the per-machine usage record, and the
  run-vs-start decision — all without spawning; `src/cli.ts` does the interactive
  TUI, the netcage query, and the spawn.

## Consequences

Breaking change from 0.4.0: a bare positional is now a PROJECT, not a host path;
`import` / `--fresh` / `--ephemeral` are gone (→ `init` /
`--delete-home`/`--delete-project` / `--rm`); old `state/<slug>/` is not migrated.
The container project path renames from `/work` to `/projects` for vocabulary
consistency (`--mount` keeps a distinct `/work`).

Deliberately OUT OF SCOPE: a fully-stateless "no host state at all" mode (the old
`--ephemeral`), and baking an exploratory machine into an image (no `anon-pi bake`
verb, no `netcage commit` dependency).
