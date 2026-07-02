---
'anon-pi': minor
---

Add `anon-pi import` and reshape the seed model so image-installed extensions
survive.

- `anon-pi import` generates the seed from your local model: it reads your host
  `~/.pi/agent/models.json`, picks the provider whose `baseUrl` serves
  `ANON_PI_LLM`, and writes just that provider to `<ANON_PI_CONFIG>/models.json`.
  No other provider's API keys, no sessions, no identity. Errors on no match,
  warns on a real-looking `apiKey`, refuses to overwrite without `--force`.
- The seed is now just `models.json`. anon-pi mounts it read-only and **copies**
  it into the container's own `~/.pi/agent` at start (instead of mounting a
  whole config dir as `PI_CODING_AGENT_DIR`), so extensions/skills baked into the
  image are no longer shadowed. pi auto-selects the local model (no default
  needed). Removed `ANON_PI_AGENT_MOUNT` and the per-session seed copy.
- README + `Dockerfile.pi`: document that extensions, skills, and their services
  (e.g. `pi-webveil` + searxng) belong in the image, installed via `pi install`.
