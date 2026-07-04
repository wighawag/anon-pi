---
title: --ephemeral home-suppression mode (a run that saves nothing, cwd /ephemeral)
slug: ephemeral-home-suppression-mode
---

# `--ephemeral`: a run that saves nothing

Proposed idea. A launch flag that suppresses ALL persistence: no machine home mounted or saved, no host-backed project, nothing written to the host workspace. The conversation and files are born and die inside the disposable container.

Note: anon-pi deliberately DELETED the old `--ephemeral` / `ANON_PI_EPHEMERAL` in the 0.4.0 -> current migration because it conflated container-lifecycle with workspace-persistence. This reintroduces the *name* but with a tight, non-conflated meaning (below), and only in shapes that cannot silently reinterpret a saved conversation.

## Meaning (settled in discussion)

- **`--ephemeral` = "do not mount or save a home" (variant a).** The container's `/root` is seeded fresh from the image's staging dir (`/opt/anon-pi-seed/agent`) each launch and dies with the container. No `machines/<m>/home` bind mount.
- **`--rm` is implied.** Ephemeral means gone; a kept container that "persists inside its own layer" is a weird half-state. So **`--keep` + `--ephemeral` is an error** (same shape as the existing `--keep`/`--rm` conflict).
- **cwd is `/ephemeral`.** Not the usual `/projects/<name>` or `/work`. The path name is deliberate **self-documenting signage**: anyone (you, or the in-jail pi agent reading its own `pwd`) sees `/ephemeral` and KNOWS this work will not survive. A persistent run shows `/projects/<name>`; an ephemeral one shows `/ephemeral`; the two are never confusable in `ps`, logs, or mountinfo. An AI agent can reason "nothing here persists" instead of being misled by a durable-looking `/projects/foo`.

## Why NOT a dedicated ephemeral machine, and why it composes with -m

A machine bundles TWO things: an **image** + a **persistent home**. `--ephemeral` only wants to drop the *home* half; it has no opinion on the *image*. Baking "ephemeral" into a machine type would force you to pin a whole separate workstation identity just to say "don't save the home", when the image is the only part you still want. So:

- `-m <machine>` still selects the **image** (and its staged extensions/tools).
- `--ephemeral` overrides only the **home** half.
- They compose freely:
  - `anon-pi --ephemeral` -> throwaway home on the default machine's image.
  - `anon-pi -m webveil --ephemeral` -> throwaway home, but with webveil's image (its staged tools present via the image staging dir; the home just is not persisted).

No new machine concept; `--ephemeral` is a home-suppression modifier and `-m` stays free.

## A project positional is REFUSED (the key rule)

`--ephemeral` + a persistent project name is **contradictory by definition**, not merely risky: a named project's conversation is a *saved* thing, and ephemeral saves nothing. There is no coherent run that is both. So:

- `anon-pi --ephemeral recon` -> **hard error** (not a warning): "ephemeral runs save no project; drop the name (`anon-pi --ephemeral`) or use a persistent run."
- This is what removes the "silently shadow / vanish an existing conversation" footgun entirely: the name is refused, so an ephemeral run can never be confused with, or clobber, a saved `recon`.

(If ever wanted, `anon-pi --ephemeral sub` -> cwd `/ephemeral/sub` is a trivial later add, an in-container-only path, never host-backed. Default is bare `/ephemeral`, no positional.)

## Image-side implication (do not forget)

pi treats its cwd as untrusted until approved; the shipped Dockerfiles stage `trust.json` trusting `/projects` and `/work`. For an ephemeral run not to prompt, staging must ALSO trust `/ephemeral`:

```
{"/projects": true, "/work": true, "/ephemeral": true}
```

So this idea carries a small image/Dockerfile change (add `/ephemeral` to the staged trust roots), else first ephemeral launch prompts.

## Honesty caveat (do not oversell)

"Not saved to your host workspace" is NOT "forensically unrecoverable". With `--rm`, podman *unlinks* the container's writable layer; unlink is not erase, and on a normal disk-backed graphroot the blocks are recoverable until reused (and SSD/CoW defeats overwrite-in-place; swap can spill). True unrecoverability additionally needs a **RAM-backed (tmpfs) netcage graphroot**, which is a netcage/deployment concern, not this flag. This idea should claim exactly: "conversation + files are never written to your host workspace and are discarded with the container", with that explicit note.

## Deferred sibling (NOT part of this)

Variant (b) "persistent home + throwaway project files" (keep the conversation, discard the artifacts) is a DIFFERENT want, it does not share the "nothing saved" premise. Keep it as its own future idea if ever needed; not folded in here.

## Composes with

- The hardened dedicated-account deployment: ephemeral = nothing to find at all; that idea = what you *do* keep is out of a host agent's casual reach.

## Open threads

- Menu/help surfacing: how `--ephemeral` appears in `anon-pi --help` and whether the bare menu offers an "ephemeral scratch" entry.
- Confirm the home-seed/promotion logic runs correctly against an in-container `/root` (no host mount) each launch.
- `--mount` interaction: `--ephemeral` + `--mount` should also be refused (a mount is a host-backed thing), or defined precisely.
