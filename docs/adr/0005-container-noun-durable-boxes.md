# Reintroduce durable mutable boxes as an explicit `container` noun

## Status

Accepted. Supersedes ADR-0004's "Lost capability" note (the single mutable
pet-container ADR-0004 deliberately dropped) and discharges the deferral in
`work/notes/ideas/container-create-flow.md`.

## Context

ADR-0004 retired `--keep` and made every launch throwaway (`--rm`): durable state
became image-based (`image snapshot` + `-i`, or a machine pinned to a snapshot
image). That is simpler, and it is the right default. But it dropped ONE
capability: a single durable jailed box a user re-enters across sessions that
ACCRETES uncommitted in-container scratch (shell history, `/tmp`, a half-built
tree) WITHOUT a snapshot step each time.

A machine pinned to a snapshot image gives a durable named environment, but it
runs a FRESH container each launch off a frozen image; it does not keep one
mutable instance alive. When mutable-instance continuity is what the user wants,
there was no clean way to get it after ADR-0004.

The old `--keep` gave it, but by FUSING two intents (create a fresh kept box /
re-enter the existing one) into one flag with an INFERRED identity key
`(machine, projectsRoot, mountParent, cwd)`. That is exactly why it could not
tell "resume my box" from "give me a new one", and it got worse once `-i` made
the image variable per launch (does `--keep -i <ref>` resume the old box or build
a new one? Neither answer is unambiguous under an inferred key). ADR-0004 dropped
`--keep` precisely to be rid of that inference.

## Decision

Reintroduce durable mutable boxes as an EXPLICIT `container` noun, NOT a flag,
with NO create-vs-enter inference. The user NAMES the box, so identity is
explicit and the resume-vs-fresh ambiguity that sank `--keep` cannot arise:

```
anon-pi container create <name> [-i <ref>] [-m <machine>] [--mount <p>] [<project>|--shell]
anon-pi container enter <name>
anon-pi container list
anon-pi container rm <name> [--yes]
```

- `create` is a `netcage run` WITHOUT `--rm` (the container survives exit). The
  box's image AND cwd are FROZEN at create: `create` takes the cwd mode word (a
  project token, `.` for the root, or `--shell`) because the box's cwd is its
  stable identity (it is also pi's conversation key). A new box is a NEW name.
- `enter` is a `netcage start` BY NAME. It takes ONLY the name: no `-i` (the
  image is fixed at create) and no project/`--shell` (the cwd is fixed at
  create), so no tag-moved and no which-cwd ambiguity ever arises. The GRAMMAR
  refuses `-i` / a project / `--shell` on `enter` with a loud error pointing at
  re-create / `image snapshot`; the enter body owns no such logic.
- `list` / `rm` are housekeeping over the boxes.

This DELIBERATELY re-opens ADR-0004's "throwaway always" drop, but ONLY as an
explicit, named, opt-in path. The bare `anon-pi <project>` launch stays
throwaway; durable mutable continuity is reachable ONLY through the `container`
noun, which the user names on purpose.

### Why (the trade-off)

- **Opt-in namespace, zero cost to non-users.** The whole capability lives behind
  a noun a user never types unless they want it. Non-users see no behaviour
  change: the default launch is still throwaway. This is why reopening the
  ADR-0004 drop is safe: it is additive, not a reversal of the default.
- **Mutable-instance continuity that snapshot + a pinned machine does not give.**
  `image snapshot` freezes a filesystem into an immutable image; a machine pinned
  to it runs a FRESH container each launch. Neither keeps ONE mutable instance
  alive across sessions. The `container` noun is exactly that instance.
- **No create-vs-enter inference.** `create` and `enter` are DISTINCT verbs, the
  name is REQUIRED (never defaulted from the project), and the image + cwd are
  frozen at create. So "resume my box" and "give me a new one" are separate,
  explicit acts. The whole string-vs-image-id keying dilemma that sank `--keep`
  never arises.

### Invariants kept

- **Forced egress is UNCHANGED.** A durable box is still FULLY jailed: the plan
  composes `--proxy <p>` + exactly one `--allow <llm>` and the two
  invariant mounts EXACTLY as a throwaway launch. `container` never weakens the
  jail; the ONLY difference from a throwaway plan is the omitted `--rm` plus a
  container name + a durable label.
- **The identity label is UNCHANGED.** Every launch (durable or throwaway) stamps
  the `anon-pi.key` machine+cwd identity label. So `forward` / `ports` resolve a
  RUNNING durable box by machine + project EXACTLY as they do a throwaway one
  (the durable field is orthogonal to the identity key). Host-port forwarding is
  unaffected by whether the container is throwaway or durable.

### The durable record lives on a netcage label, not an anon-pi registry

A durable box is stamped with an `anon-pi.container=<name>` label (its VALUE is
the box's user-chosen name), distinct from the `anon-pi.key` identity label. That
label IS the record: `container list` / `rm` enumerate and name boxes off it, so
there is NO anon-pi-side registry file to drift or clean up. The box's image +
home + cwd are read back off the netcage container (label / inspect), consistent
with anon-pi's "netcage owns the container; anon-pi invents no state file" stance.

### Reserved noun word

`container` JOINS the reserved subcommand nouns alongside `machine` and `image`
(the actual verb nouns), so a same-named project can never shadow the subcommand.
(`project` is the named thing and `--mount` is a flag, so neither is a reserved
noun.)

## Consequences

- `container` is dispatched BEFORE the launch grammar and reserved in
  `RESERVED_NAMES`; a project can no longer be named `container`.
- A new `durable` shape threads through the single run-plan composition
  (`resolveRunPlan`): it OMITS `--rm`, `--name`s the container, and stamps the
  `anon-pi.container` label. It does NOT fork a parallel launch path.
- The impure verb bodies (create/enter, list/rm) land in follow-up tasks
  (`container-create-enter`, `container-list-rm`); this decision + the pure
  foundation (parse, reserved word, durable plan, dispatch/help) land together.
- The `--container <name>` launch shorthand (create-or-enter in one call) is
  explicitly OUT of scope: it would re-import the create-vs-enter inference and
  the `-i`-silently-ignored footgun. Captured, with its shortcoming, in
  `work/notes/ideas/container-flag-shorthand.md`; revisit only if the two-step
  proves to be real daily friction.
