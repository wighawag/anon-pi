---
title: A `container` noun - explicit durable named boxes (create then enter), no inference
slug: container-create-flow
---

# An explicit `container` noun (create, then enter)

Proposed idea (deferred; captured during the ADR-0003/0004 grill). After
retiring `--keep` (ADR-0004), persistence is image-based and every launch is
throwaway. That is simpler, but it drops one capability: a SINGLE durable box you
re-enter across sessions that accretes uncommitted in-container state. If that
workflow proves central, reintroduce it as an EXPLICIT noun rather than the old
inferred `--keep`.

## Why a noun, not a flag

`--keep` fused two intents (create a fresh kept container / re-enter the existing
one) into one flag with INFERRED identity, which is exactly why it could not tell
"resume my box" from "give me a new one" (worsened once `-i` makes the image
variable). A noun removes the inference: the user NAMES the container, so
identity is explicit and there is no resume-vs-fresh ambiguity.

```
anon-pi container create <name> -m <machine> [-i <image>] [--mount <p>] ...
    # instantiate a durable jailed box (podman run WITHOUT --rm), pinned to its
    # creation-time image + home + cwd. Named. Listed. No inference.
anon-pi container enter <name> [<project>|--shell]
    # re-enter it (netcage start); no -i (image is fixed at create), so no
    # tag-moved ambiguity ever arises.
anon-pi container list
anon-pi container rm <name>
```

## What this cleanly solves (that snapshot does not)

- A single MUTABLE box that accretes uncommitted scratch (shell history, /tmp,
  a half-built tree) across re-entries, without a commit step each time.
- Zero resume-vs-fresh ambiguity: re-enter is BY NAME; a new box is a new name.
  The whole string-vs-image-id keying dilemma never arises.

## Open questions / tradeoffs

- Ergonomics vs the old one-liner: `--keep` was one command; this is create then
  enter. A combined "create-or-enter" convenience must NOT smuggle back inference
  (defaulting the name to the project re-introduces the ambiguity we removed). If
  we default the name, we are back to `--keep`. So: require an explicit name, or
  accept a weaker convenience.
- Overlap with "machine pinned to a snapshot image": that ALREADY gives a durable
  named environment (a real name, fresh container each launch from a frozen
  image). The container noun differs only by keeping ONE mutable instance alive
  vs a fresh instance off a frozen image. Is the mutable-instance continuity
  actually wanted, or does snapshot+machine cover it in practice? (This is the
  question that decides whether to build this at all.)
- Conversation keying: pi keys conversations by cwd regardless; a named container
  still cwds into /projects/<p>, so its conversations live in the machine home as
  usual. The container noun is about the FILESYSTEM instance, orthogonal to the
  home + conversations.
- Relation to netcage: netcage already supports kept containers (`run` without
  `--rm`, `netcage start`, the managed label). The noun is an anon-pi-side naming
  + lifecycle layer over that, WITHOUT the identity inference anon-pi used to do.

## Decision recorded

Deferred. Retire `--keep` now (ADR-0004); only build this noun if durable
mutable named boxes prove to be a primary workflow that snapshot + a pinned
machine does not satisfy.
