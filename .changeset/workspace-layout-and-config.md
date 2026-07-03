---
'anon-pi': minor
---

Add the pure workspace-layout foundation for the machines + projects model.

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
