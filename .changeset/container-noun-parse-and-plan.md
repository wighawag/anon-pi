---
'anon-pi': minor
---

Add the pure foundation of a new `container` noun: explicit durable named boxes
(`create` / `enter` / `list` / `rm`) that SURVIVE exit, reintroducing the mutable
single-box continuity ADR-0004 dropped, but as an explicit, opt-in, NAMED noun
with no create-vs-enter inference.

This lands the PURE parts + the wiring; the impure verb bodies follow:

- `parseContainerArgs` parses the four verbs into a typed `ContainerCommand`.
  `create <name> [-i <ref>] [-m <machine>] [--mount <p>] [<project>|--shell]`
  freezes the box's image + cwd at create (so it takes the cwd mode word);
  `enter <name>` takes ONLY the name and grammatically REFUSES `-i` and a
  project/`--shell` (both frozen at create), pointing at re-create / `image
  snapshot`.
- `container` is now a RESERVED noun word (alongside `machine` / `image`): a
  project can no longer be named `container`.
- The run-plan composition (`resolveRunPlan`) is parameterised on a `durable`
  shape: a durable plan OMITS `--rm`, `--name`s the container, and stamps an
  `anon-pi.container=<name>` label, while keeping the two invariant mounts and the
  forced-egress proxy + single `--allow-direct` EXACTLY as a throwaway launch. The
  `anon-pi.key` identity label is unchanged, so `forward` / `ports` resolve a
  RUNNING durable box just as they do a throwaway one.
- `anon-pi container --help` and the `container` dispatch are live end-to-end; the
  create/enter/list/rm bodies are stubbed here (they land in follow-up tasks).

This DELIBERATELY re-opens ADR-0004's "throwaway always" drop, but only for the
opt-in `container` path (the bare launch stays throwaway). Recorded in
`docs/adr/0005-container-noun-durable-boxes.md`, which SUPERSEDES ADR-0004's
"lost capability" note. A durable box is still FULLY jailed; the jail is never
weakened.
