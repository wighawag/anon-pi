---
'anon-pi': minor
---

Align the shipped images with the machines + projects vocabulary: the container
projects root is now `/projects` (was `/work`), so the concept is "project"
everywhere and the images agree with the RunPlan's paths.

- `Dockerfile.pi` and `examples/Dockerfile.pi-webveil`: `WORKDIR` is now
  `/projects` (the projects-root cwd, pi's default). `/work` is kept as the
  DISTINCT `--mount` root, so the two roots never collide.
- The staged `trust.json` (in `/opt/anon-pi-seed/agent`, promoted into the
  machine home on first launch) now trusts BOTH cwd roots pi launches into,
  `/projects` and `/work`, so pi never prompts on the mounted project on any
  launch mode.
- `Dockerfile.pi` seeds base `/root` shell dotfiles (`.bashrc`, `.profile`) from
  `/etc/skel` if absent, so a fresh machine home has defaults to fall back to
  (the home bind-mounts over `/root`).
