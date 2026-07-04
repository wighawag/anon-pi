---
'anon-pi': patch
---

Rewrite the README around the shipped **machines + projects** model and add a
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
