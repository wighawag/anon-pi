---
'anon-pi': minor
---

First-run onboarding + a projects-root step in `init`.

- **Auto-onboard on first launch.** Running a launch (e.g. `anon-pi` or
  `anon-pi <project>`) with no `config.json` yet now shows a short welcome and
  runs `anon-pi init` automatically, then continues into the launch — instead of
  failing deep with the bare "set `ANON_PI_PROXY`" guidance the first time. It
  only auto-onboards on an interactive terminal; a script (no TTY) still gets the
  fail-closed proxy error, and an env-driven run (`ANON_PI_PROXY` set) skips
  onboarding entirely.
- **`init` gained a projects-root step (now 4 steps).** After the image step,
  `init` asks for the projects root — the host folder mounted at `/projects`
  where bare `anon-pi` looks for projects — defaulting to `~/.anon-pi/projects/`.
  Point it at your own dev folder to jail pi into files you edit with host tools;
  `--mount <parent>` still overrides it per-launch. Accepting the default leaves
  `config.json` clean (no explicit `projects` key).
