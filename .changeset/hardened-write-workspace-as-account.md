---
'anon-pi': patch
---

Fix `EACCES: permission denied, mkdir '/home/anon/.anon-pi'` when hardening via `init` (and the identical bug in `persona add`).

On a hardened install the workspace lives in the dedicated account's mode-700 home, which the login user cannot write. `init`'s hardening step (and `persona add`) tried to `mkdir`/write that home AS THE LOGIN USER, which crashed with EACCES; and even absent the crash, the config/machine/models writes landed in the login user's `~/.anon-pi` instead of the account's, so a hardened launch (which self-re-execs as the account) would find no config.

The workspace writes now happen AS the account, per ADR-0006 ("the login user must not write the workspace"). anon-pi crosses the same way a launch does, by spawning `sudo -u <account> -i anon-pi __init-apply` (permitted by the scoped sudoers rule), and pipes the already-resolved config on STDIN (not an argv path or a temp file), so nothing sensitive appears in `ps` and the `--force-allow-local-llm-api-key` case does not leak. The account-side child performs the writes into its own mode-700 `~/.anon-pi`. Non-hardened installs are unchanged (they write locally as before).
