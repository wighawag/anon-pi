---
title: container noun - arg parse, reserved word, durable run-plan, and the superseding ADR
slug: container-noun-parse-and-plan
spec: container-noun
blockedBy: []
covers: [5, 6, 9, 10, 11, 12, 13]
---

## What to build

The PURE foundation of the `container` noun plus the ADR that records the
deliberate reversal of ADR-0004's "throwaway always". A thin end-to-end path: a
new `container <verb>` grammar parses, `container` is a reserved word, the
run-plan can compose a DURABLE (non-`--rm`) netcage argv, and a minimal CLI
dispatch wires it so `anon-pi container --help` and the parse errors are reachable
(the four verbs' impure bodies land in the sibling tasks).

- **Parse:** a pure `parseContainerArgs` (mirroring `parseImageArgs` /
  `parseMachineArgs`) that returns a `ContainerCommand` discriminated union over
  the four verbs: `create <name> [-i <ref>] [-m <machine>] [--mount <p>]
  [<project>|--shell]`, `enter <name>`, `list`, `rm <name> [--yes]`. `create`
  takes the cwd mode word (a project token or `--shell`) because the box's cwd is
  FROZEN at create; `enter` takes ONLY the name (no `-i`, no project/`--shell`) and
  must REFUSE those with a loud error pointing at re-create / `image snapshot`.
  `<name>` is validated via `validateName` (the reserved/traversal guard).
- **Reserved word:** add `container` to `RESERVED_NAMES` so a same-named project
  can never shadow the subcommand.
- **Durable run-plan:** parameterise the existing run-plan composition on
  throwaway-vs-durable so a durable plan OMITS `--rm`, stamps a durable-box NAME
  label AND the existing `anon-pi.key` identity label (the well-formed
  `launchIdentityKey`: machine + cwd), and freezes the image + cwd into the plan.
  The identity label MUST be present on the durable plan exactly as on the
  throwaway plan, so `forward` / `ports` (which decode it via `parseKeptKey` /
  `keyProject` to filter RUNNING managed containers by machine + project) resolve a
  running durable box unchanged (story 13). Keep the forced-egress invariants
  (proxy + the one `--allow-direct`) UNCHANGED and ALWAYS present - a durable box
  is still fully jailed. Do NOT fork a parallel launch path; parameterise the one
  that exists.
- **Dispatch + help:** route `anon-pi container <verb>` to a `runContainer`
  dispatch and add `container --help`, so the grammar + reserved word are
  reachable end-to-end (verb bodies may be stubbed here; they are filled by the
  create-enter and list-rm tasks).
- **ADR:** write `docs/adr/<n>-container-noun-durable-boxes.md` recording the
  decision to reintroduce durable mutable named boxes as an explicit noun,
  SUPERSEDING ADR-0004's "Lost capability" note and the deferral in
  `work/notes/ideas/container-create-flow.md`. Capture WHY: opt-in namespace (zero
  cost to non-users), mutable-instance continuity that snapshot+pinned-machine
  does not give, no create-vs-enter inference (create/enter are distinct verbs,
  name required, image+cwd frozen at create). Note that `container` joins the
  reserved subcommand nouns alongside `machine` / `image` (the ACTUAL verb nouns;
  `project` is the named thing and `--mount` is a flag, so neither is a reserved
  noun - do not claim they are).

## Acceptance criteria

- [ ] `parseContainerArgs` parses all four verbs into a typed union; the PARSER
      REFUSES `-i` and a project/`--shell` token on `enter` with a clear AnonPiError
      (the enter body relies on this grammatical refusal, so it owns nothing);
      `create` requires an explicit `<name>` and rejects an unknown flag.
- [ ] `container` is in `RESERVED_NAMES` (a project cannot be named `container`).
- [ ] The run-plan composes a DURABLE argv (no `--rm`, durable-name label,
      image+cwd frozen) while KEEPING the two invariant mounts and the forced-egress
      proxy + single `--allow-direct` exactly as the throwaway plan does.
- [ ] The durable plan stamps the `anon-pi.key` identity label (the well-formed
      `launchIdentityKey`: machine + cwd) exactly as the throwaway plan does, so a
      RUNNING durable box is resolvable by `forward` / `ports` (story 13). A test
      asserts the durable plan carries a decodable identity key.
- [ ] `anon-pi container --help` prints and `anon-pi container <bad>` errors via
      the standard AnonPiError path (exit 1).
- [ ] An ADR exists under `docs/adr/` superseding ADR-0004's lost-capability note,
      with the WHY (opt-in namespace, mutable continuity, no inference).
- [ ] Tests cover the new behaviour (mirror the repo's existing pure-parser +
      run-plan test style: a new `parse-container.test.ts` and durable-plan cases
      alongside `run-plan.test.ts`).
- [ ] A changeset is added (`pnpm changeset`) - a MINOR bump (new `container`
      grammar + reserved word), noting the ADR-0004 reversal.

## Blocked by

- None - can start immediately.

## Prompt

> Build the PURE foundation of a new `container` noun for anon-pi plus its ADR.
> anon-pi is a host-side launcher for netcage (a podman-replacement that forces
> all egress through a socks5h proxy, fail-closed). Domain vocabulary is in
> `CONTEXT.md`; the noun's spec is `work/specs/tasked/container-noun.md` (READ IT
> FIRST). The `container` noun reintroduces the durable mutable box `--keep` used
> to give (retired by ADR-0004), but as an EXPLICIT noun with no create-vs-enter
> inference: `create` (netcage run WITHOUT `--rm`, image+cwd FROZEN), `enter`
> (netcage start by name, no `-i`, no re-cwd), `list`, `rm`.
>
> FIRST, check this task against current reality (it is a launch snapshot and may
> have DRIFTED): confirm ADR-0004 still describes throwaway-always and that the
> run-plan still hard-codes `--rm` in one place; confirm `parseImageArgs` /
> `parseMachineArgs` / `RESERVED_NAMES` / `validateName` are still the patterns to
> mirror. If a dependency landed differently, route to needs-attention rather than
> build on a stale premise.
>
> Look (by concept, not brittle paths): the pure parsers and the run-plan
> composition live in the `anon-pi` package's core module (search
> `parseImageArgs`, `resolveRunPlan`, `RESERVED_NAMES`, `launchIdentityKey`); the
> noun dispatch + `--help` live in the CLI module (search `runImage`,
> `args[0] === 'image'`). Test at the pure seam the repo already uses (a
> `parse-*.test.ts` for the parser; `run-plan.test.ts`-style fixtures for the
> durable plan) - unit tests over fixtures, no spawning.
>
> This task OWNS the ADR-0004 reversal: the durable-plan change IS the decision,
> so write the ADR here (do NOT leave it implicit). Keep the forced-egress
> invariant intact - a durable box is still fully jailed; never weaken the proxy /
> `--allow-direct` composition. The impure verb bodies (create/enter, list/rm) are
> separate tasks that depend on this one; a stub dispatch is fine here.
>
> RECORD non-obvious in-scope decisions (new exit codes, the durable-label
> encoding, how the throwaway-vs-durable switch threads through the plan): the
> ADR covers the big reversal; note smaller choices in the done record / PR.
> "Done" = the grammar parses + reserved + a durable plan composes + dispatch/help
> reachable + ADR written + tests green + a changeset added.

---

### Claiming this task

```sh
dorfl claim container-noun-parse-and-plan --arbiter origin
git fetch origin && git switch -c work/container-noun-parse-and-plan origin/main
git mv work/tasks/ready/container-noun-parse-and-plan.md work/tasks/done/container-noun-parse-and-plan.md
```
