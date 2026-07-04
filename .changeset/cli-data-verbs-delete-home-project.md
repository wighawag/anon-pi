---
'anon-pi': minor
---

Add the destructive cleanup verbs `anon-pi --delete-home [<machine>]` and
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
