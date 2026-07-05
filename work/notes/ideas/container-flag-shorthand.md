---
title: A `--container <name>` launch shorthand over the container namespace (create-or-enter convenience)
slug: container-flag-shorthand
---

# A `--container <name>` launch shorthand (deferred, has a known shortcoming)

Proposed idea (deferred; may revisit). This assumes the explicit `container`
noun (`container-create-flow.md`) is ALREADY implemented: `container create
<name>`, `container enter <name>`, `container list`, `container rm`. On top of
that, add a one-line launch shorthand:

```
anon-pi --container <name> [<project>|--shell] [-i <image>] [-m <machine>] [--mount <p>] ...
    # if <name> exists  -> enter it (like `container enter <name>`)
    # if <name> is new   -> create it (like `container create <name> ...`), then enter
```

It collapses the two-step create-then-enter into the single ergonomic call
`--keep` used to be, while keeping the name EXPLICIT (never inferred from the
project), so the WHICH-box ambiguity of `--keep` stays gone.

## Why this is tempting

- One command for the common loop: `anon-pi --container recon-box recon` both the
  first time and every time after. No "create it, then remember to enter it."
- Name is required and explicit, so the identity inference that sank `--keep`
  (defaulting the box to the project) never returns.

## The known shortcoming (why it is deferred, not built)

`--container <name>` re-imports the CREATE-vs-ENTER lifecycle inference that the
two-verb noun deliberately removed. The flag cannot tell "make me a fresh box"
from "re-enter my box" except by probing existence, and that collides head-on
with `-i`:

- `-i <image>` is only meaningful at CREATE (the container freezes its image at
  creation; `container enter` takes no `-i`).
- So on a `--container <name>` call, `-i` is honoured when the name is NEW and
  SILENTLY IGNORED when it already exists. The user who writes
  `--container recon-box -i other/img recon` expecting to switch the image gets
  their old image with no error, only (at best) a runtime "-i ignored, the
  container's image is fixed" message.

That "your flag was silently ignored, see the message" footgun is EXACTLY what
the two-verb form makes structurally impossible: `-i` lives on `create` (where it
binds) and is not a parameter of `enter` (nothing to ignore). A runtime warning
papers over the confusion instead of removing it.

## Standing recommendation

For a persistent container, the two-command setup (`container create` then
`container enter`) is CLEARER. Create-on-demand via a single flag is confusing
precisely because `-i` is required-at-create but meaningless-at-enter, and one
flag cannot honour both honestly. Prefer the noun.

## Decision recorded

Deferred. Ship the `container` noun first (`container-create-flow.md`). Only add
this `--container <name>` shorthand later IF the create-then-enter two-step
proves to be real friction in daily use, and only with the `-i` behaviour spelled
out in the help text and a loud (not silent) message when `-i` is dropped on an
existing container. If in doubt, do not add it: the noun already covers the need
unambiguously.
