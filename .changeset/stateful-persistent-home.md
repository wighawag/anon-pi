---
'anon-pi': minor
---

Make anon-pi STATEFUL: persist pi's home across launches, with first-launch
seeding (Model B + C).

- anon-pi now mounts a persistent per-workdir host dir at the container's
  `~/.pi/agent`, so sessions, history, settings (your model choice), and any
  extensions you `pi install` all survive across launches. Re-running in the
  same folder resumes it. The state dir is `<ANON_PI_HOME>/state/<workdir>/agent`,
  named with pi's own readable path convention (not a hash).
- First-launch seed-if-fresh: on a fresh home the image's staged defaults
  (`/opt/anon-pi-seed/agent`: extensions, `trust.json`) and your imported
  `models.json` are promoted in once and a `.anon-pi-seed` marker is stamped;
  thereafter pi owns the home and nothing is clobbered. Resolves the "changed my
  model / installed an extension and it forgot" and the repeated `fd` download.
- `--ephemeral` / `ANON_PI_EPHEMERAL=1`: mount NO writable state. pi writes to
  the container's own `--rm` layer, destroyed on exit, so nothing writable ever
  touches a host path, there is no cleanup, and nothing is left behind even on a
  crash. (Only the read-only models.json seed is mounted.)
- Images now install extensions + config into the STAGING dir
  (`PI_CODING_AGENT_DIR=/opt/anon-pi-seed/agent pi install ...`), not
  `~/.pi/agent` (which is the mount and would be shadowed). Updated `Dockerfile.pi`
  and `examples/Dockerfile.pi-webveil`.
