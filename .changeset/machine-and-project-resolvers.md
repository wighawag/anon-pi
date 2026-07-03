---
'anon-pi': minor
---

Add the pure machine + project resolvers, name validation, and the `.` root
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
