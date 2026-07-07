---
'anon-pi': patch
---

Fix two hardened-reinit bugs: a login-home projects root leaking into the account config (causing `mkdir /home/<you>/... EACCES` at launch), and prompt defaults not reflecting the account's existing config.

- **`init` wrote a login-home projects root into the account config.** `projects: projects ?? current.projects` fell back to the login user's stored `projects` (e.g. `/home/<you>/anon`) even when you kept the safe anon-tree default, so the hardened launch then tried `mkdir /home/<you>/anon/<project>` and hit `EACCES`. There is now a final guard: on a hardened install a login-home projects value is never stored (dropped to the safe anon-tree default).
- **Hardened re-init pre-filled from the wrong config.** `init` runs as the login user and read the login user's `~/.anon-pi/config.json` for its defaults, which on a hardened box is just the `{ hardened: true }` marker (or a stale non-hardened config), so the prompts did not reflect what the `anon` account previously chose. On a hardened install `init` now reads the account's own config (via a `sudo -u anon -i anon-pi __read-config` crossing) and uses that for every prompt default.
