---
title: container create + enter - durable box lifecycle (frozen image + cwd, refuse-if-running)
slug: container-create-enter
spec: container-noun
blockedBy: [container-noun-parse-and-plan]
covers: [1, 2, 3, 4]
---

## What to build

The two lifecycle verbs' impure bodies, on top of the parse + durable run-plan
from `container-noun-parse-and-plan`. A user can `container create <name>` a
durable jailed box and `container enter <name>` back into it with its accreted
state intact.

- **`container create <name> [-i <ref>] [-m <machine>] [--mount <p>]
  [<project>|--shell]`:** compose the durable run-plan (netcage run WITHOUT
  `--rm`) and spawn it. Resolve the image via the normal chain `-i` >
  `machine.json.image` > `ANON_PI_IMAGE` > error, and FREEZE it (plus the resolved
  cwd) as the box's fixed identity. FAIL FAST if a container named `<name>`
  already exists (never silently re-enter or clobber). `-m` picks the HOME,
  `--mount` composes exactly as a normal launch.
- **`container enter <name>`:** `netcage start` the STOPPED box at its FROZEN cwd
  and attach. If the box is already RUNNING, REFUSE with a clear error (it is a
  live instance; reach it via `forward`/`ports`, or `container rm` to reset it).
  `enter` takes no `-i` and no project/`--shell` (both frozen at create) - the
  parser already rejects them; the body relies on that.

## Acceptance criteria

- [ ] `container create <name>` starts a durable (non-`--rm`) jailed box with the
      image frozen from the resolution chain and the cwd frozen from the create-time
      mode word; forced-egress (proxy + one `--allow-direct`) is intact.
- [ ] `container create` on an EXISTING name fails fast with a clear error (no
      re-enter, no clobber).
- [ ] `container enter <name>` re-enters a STOPPED box at its frozen cwd; on an
      already-RUNNING box it REFUSES with guidance (not a second attach).
- [ ] `container enter` on an UNKNOWN name errors (never a silent success).
- [ ] Tests cover the new behaviour (mirror the impure `cli-*.test.ts` /
      `*-verbs.test.ts` style; a new `cli-container.test.ts`), stubbing the netcage
      spawns at the same seam the existing verb tests use.
- [ ] If any test touches a real home/config/projects location, it ISOLATES it to
      a temp/scratch dir (via the repo's env/config overrides) AND asserts the real
      one is UNTOUCHED after the run.
- [ ] A changeset is added (`pnpm changeset`).

## Blocked by

- `container-noun-parse-and-plan` - needs the `ContainerCommand` parse, the
  durable run-plan, and the `runContainer` dispatch.

## Prompt

> Implement `container create` and `container enter` for anon-pi's new `container`
> noun. READ `work/specs/tasked/container-noun.md` and the ADR the parse-and-plan
> task wrote (`docs/adr/*container*`) FIRST; `CONTEXT.md` has the domain
> vocabulary. anon-pi launches pi inside a netcage jail; a durable box is a netcage
> container run WITHOUT `--rm` (so it survives exit) that the user re-enters via
> `netcage start`. The image + cwd are FROZEN at create, so there is no
> create-vs-enter inference and no `-i` on enter.
>
> FIRST, check this task against reality: confirm `container-noun-parse-and-plan`
> landed as assumed - the `ContainerCommand` union (create/enter/list/rm), the
> durable run-plan variant (no `--rm`, durable-name label, forced-egress intact),
> and the `runContainer` dispatch stub. If it landed differently (e.g. the durable
> label encoding, or where the throwaway-vs-durable switch lives), build on what
> actually landed, and if it contradicts this task route to needs-attention.
>
> Look (by concept): the impure verb bodies live in the CLI module next to
> `machineCreate` / the image verb bodies (search `runMachine`, `machineCreate`,
> the netcage `spawnSync`/`spawn` calls); reuse the image-resolution chain the
> launch path already uses (`-i` > machine.json > `ANON_PI_IMAGE`). Test at the
> impure seam the existing verb tests use (`cli-machine.test.ts` /
> `machine-verbs.test.ts` for the shape): stub the netcage spawn, assert the
> composed argv + the refusals. Isolate any real home/config write to a temp dir
> and assert the real one is untouched.
>
> RECORD non-obvious in-scope decisions (the exact already-running refusal exit
> code + message, how create detects an existing box, how the frozen cwd is read
> back on enter) in the done record / PR. "Done" = create makes a durable box
> (frozen image+cwd, fail-fast on dup), enter resumes a stopped box + refuses a
> running one + an unknown name, tests green, a changeset added.

---

### Claiming this task

```sh
dorfl claim container-create-enter --arbiter origin
git fetch origin && git switch -c work/container-create-enter origin/main
git mv work/tasks/ready/container-create-enter.md work/tasks/done/container-create-enter.md
```
