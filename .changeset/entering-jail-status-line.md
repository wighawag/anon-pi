---
'anon-pi': patch
---

Print a status line before entering the jail, and refresh the build-verb docs
for netcage 0.7.1.

- **Explain the launch pause.** Every launch now prints
  `anon-pi: entering the netcage jail (setting up forced-egress)…` (to stderr)
  right before spawning netcage. netcage sets up the jail (netns, firewall, DNS,
  container start) before pi paints, so without this the user saw only a blinking
  cursor during the gap. The message is transient (pi clears the screen when its
  TUI comes up) and covers the menu, direct, and shell launch paths through the
  single `spawnNetcage` chokepoint.
- **Docs honesty for netcage 0.7.1.** The `netcage build`/`load` verbs shipped in
  netcage 0.7.1, so the README and `buildImage`/`loadImageIntoNetcageStore`
  comments no longer frame them as a "future"/"interim" workaround. The preferred
  native `netcage build` path is unchanged.
