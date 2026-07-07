---
'anon-pi': patch
---

Fix: `init` / `persona` must not be redirected into the account (they provision it and cross themselves).

On a hardened install the launch self-re-exec (`sudo -u anon -i anon-pi "$@"`) ran before subcommand dispatch, so `anon-pi init` (and `persona add`/`rm`) were crossed into the `anon` account first. `init` then ran AS `anon` and, at the image step, tried to `sudo -u anon ...` from within `anon` -> "anon is not in the sudoers file. This incident has been reported to the administrator." (the account has no sudo rights).

`init` and `persona` are now dispatched BEFORE the redirect, so they run as the login user (which owns the sudoers rights) and do their own explicit crossings into the account. Launches (`anon-pi <project>`, `--shell`) and workspace-scoped verbs (`machine`, `image`, `container`) still redirect as before.
