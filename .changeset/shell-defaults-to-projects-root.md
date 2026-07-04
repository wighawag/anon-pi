---
'anon-pi': minor
---

`--shell` with no project now lands at the projects root (`/projects`, or
`/work` under `--mount`) instead of the machine home (`/root`). The model is
project-centric and the shell is the project-hopper, so the projects root is the
natural landing; anything written under the machine home persists into that
machine's config home on the host, which is for config, not work. `--shell .` is
now an exact synonym for a bare `--shell`, and the machine home is still one
`cd ~` away inside the jail.
