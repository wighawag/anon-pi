---
title: container list + rm - durable box housekeeping (identity readout, --yes stop-then-remove)
slug: container-list-rm
spec: container-noun
blockedBy: [container-create-enter]
covers: [7, 8]
---

## What to build

The two housekeeping verbs' impure bodies, completing the `container` noun. A
user can see their durable boxes and remove them explicitly.

- **`container list`:** read the netcage container listing, FILTER to anon-pi
  durable boxes (the durable-name label the create path stamps), and print each
  with enough identity: name, machine, image, cwd/project, and running-or-stopped.
  Read-only; identity comes off the labels / inspect, NOT an anon-pi-side registry.
- **`container rm <name>`:** on a RUNNING box, require `--yes` and then
  STOP-then-remove it (one call, atomic from the user's view); WITHOUT `--yes`,
  refuse and report that the box is running + to re-run with `--yes` (mirrors the
  existing delete verbs' non-interactive guard). On a STOPPED box, remove directly.
  An UNKNOWN name errors (never a silent success).

`blockedBy: [container-create-enter]` serializes the two impure verb tasks: both
edit the CLI module + the `cli-container.test.ts` file, so ordering them avoids a
merge conflict (they are otherwise logically independent).

## Acceptance criteria

- [ ] `container list` shows each durable box with name, machine, image,
      cwd/project, and running state, reading identity off labels / inspect (no
      anon-pi registry file), filtered to anon-pi durable boxes only.
- [ ] `container rm <name>` on a RUNNING box requires `--yes` and then
      stop-then-removes; without `--yes` it refuses with the "it is running, re-run
      with --yes" guidance.
- [ ] `container rm <name>` on a STOPPED box removes directly; an UNKNOWN name
      errors.
- [ ] Tests cover the new behaviour (extend `cli-container.test.ts` from the
      create-enter task, same impure seam), stubbing the netcage listing/rm spawns.
- [ ] If any test touches a real home/config/projects location, it ISOLATES it to
      a temp/scratch dir AND asserts the real one is UNTOUCHED after the run.
- [ ] A changeset is added (`pnpm changeset`).

## Blocked by

- `container-create-enter` - serialized to avoid conflicting edits in the CLI
  module + `cli-container.test.ts`; also depends on the durable-name label the
  create path stamps (what `list` filters on and `rm` targets).

## Prompt

> Implement `container list` and `container rm` for anon-pi's `container` noun,
> completing the four verbs. READ `work/specs/tasked/container-noun.md` and the
> container ADR FIRST; `CONTEXT.md` has the vocabulary. A durable box is a netcage
> container run WITHOUT `--rm`, carrying a durable-name label the create path
> stamps; there is NO anon-pi-side registry - the netcage container + its labels
> ARE the record (mirror the `image list` decision in ADR-0003, which reads
> provenance off image labels).
>
> FIRST, check this task against reality: confirm `container-create-enter` landed
> as assumed - the durable-name label encoding `list` must filter on and `rm` must
> target, and the netcage spawn seam the verb bodies use. If it landed differently,
> build on what actually landed; if it contradicts this task, route to
> needs-attention.
>
> Look (by concept): model `list` on `imageList` / `machineList` (search
> `runImage`, `imageList`, the netcage listing spawn + JSON parse) and `rm` on
> `machineRm` (search `machineRm`, the `--yes` guard `-y`). Test at the impure seam
> the existing verb tests use: stub the netcage listing / stop / rm spawns and
> assert the readout + the `--yes` running-box guard + the unknown-name error.
> Isolate any real home/config write to a temp dir and assert the real one is
> untouched.
>
> RECORD non-obvious in-scope decisions (the exact `list` columns/format, the
> running-box refusal exit code, whether `rm --yes` on a stopped box is a no-op
> stop then remove or just remove) in the done record / PR. "Done" = list shows the
> durable boxes with identity, rm guards a running box behind `--yes` and
> stop-then-removes, unknown name errors, tests green, a changeset added.

---

### Claiming this task

```sh
dorfl claim container-list-rm --arbiter origin
git fetch origin && git switch -c work/container-list-rm origin/main
git mv work/tasks/ready/container-list-rm.md work/tasks/done/container-list-rm.md
```
