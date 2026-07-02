---
'anon-pi': minor
---

Add `anon-pi --fresh [WORKDIR]`: delete this workdir's persistent state home
before launching, so the (possibly rebuilt) image's staged defaults and your
imported `models.json` are re-seeded on this launch. Use it after rebuilding your
image to pick up new extensions/config without hand-deleting the state dir.
`--fresh` with `--ephemeral` is rejected (an ephemeral session is always fresh).
