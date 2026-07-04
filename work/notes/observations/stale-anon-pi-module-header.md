# Stale module header in src/anon-pi.ts (2026-07-04)

The top-of-file docblock in `packages/anon-pi/src/anon-pi.ts` (lines ~1-20,
"What anon-pi does (settled design)") still describes the RETIRED 0.4.0
per-workdir model: `~/.config/anon-pi/agent` seed, per-workdir session dir keyed
by absolute-workdir hash, the `PI_CODING_AGENT_DIR` mount, and
"Session identity = the ABSOLUTE workdir path". None of that matches the current
machines + projects model (two invariant mounts `/root` + `/projects`, per-machine
home, `~/.anon-pi/`). Noticed while retiring the legacy pure surface; left
untouched (a doc rewrite is outside that deletion task's scope). Worth a targeted
header refresh so the module's own narrative reflects the new model.
