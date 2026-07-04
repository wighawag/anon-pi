---
'anon-pi': patch
---

Polish + docs, resolving two filed observations:

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
