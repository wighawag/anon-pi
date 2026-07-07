---
'anon-pi': patch
---

Fix: a hardened install did not redirect at launch (showed the login user's projects instead of the `anon` account's).

The launch redirect decision (`isHardenedInstall`) runs as the LOGIN USER, before crossing, so it reads the login user's `~/.anon-pi/config.json`. But a hardened `init` writes the whole workspace (including `hardened: true`) into the `anon` account's mode-700 home, and nothing into the login user's home. So the login user's config had no `hardened` flag (or a stale non-hardened one from an earlier init), the redirect never fired, and `anon-pi` ran as you, reading your login-user projects.

A hardened `init` now also writes a minimal login-side marker (`{ "hardened": true }`) into the login user's `~/.anon-pi/config.json`, so every future launch redirects into `anon`. The marker carries nothing sensitive (no proxy/llm/projects, no transcripts); the real workspace config still lives under the account and is read after the crossing.

Note: on an existing box that hardened before this fix, re-run `anon-pi init` once to write the marker.
