---
'anon-pi': minor
---

init: don't rebuild a shipped image that already exists.

Choosing the basic/webveil image at init's image step always ran the (multi-minute) `podman`/`netcage build`, even when the exact tag was already in netcage's store. Re-running `init` (e.g. after an anon-pi upgrade, whose new versioned install path can also bust the build cache) therefore re-triggered a full rebuild.

init now checks whether the shipped tag (`localhost/anon-pi/pi[-webveil]:latest`) is already present (`netcage images --format json`) and offers to REUSE it (default) instead of rebuilding; answer `n` to force a fresh build. New pure `imageTagPresent` does the match, tolerant of the `localhost/` prefix and an implicit `:latest`. The store probe fails toward building (never toward a stale skip), so a probe miss can't reuse a missing image.
