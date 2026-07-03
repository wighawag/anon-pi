---
'anon-pi': minor
---

Add the pure run-vs-start decision rule for kept (`netcage.managed`) containers
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
