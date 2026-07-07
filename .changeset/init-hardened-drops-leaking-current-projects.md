---
'anon-pi': patch
---

init: on a hardened (re)configure, don't keep a stored projects root that leaks the login home.

Re-running `init` over an existing config offered the stored projects root as the Enter-default. On a hardened install, if that stored value was under the login home (e.g. `/home/<user>/anon`, carried over from a previously non-hardened install), it was still shown as the default AND pressing Enter kept it, silently re-mounting the login-home path and re-introducing the exact username leak the hardened projects step exists to prevent (the leak check only ran on a typed path, not on Enter/keep).

Now a stored projects root that leaks under hardening is NOT kept: the prompt defaults to the `anon`-account tree, explains that the current value was dropped, and neither Enter nor Ctrl-C can retain the leaking path. New pure `resolveInitProjectsDefault` encodes the keep-vs-drop decision (unit-tested). Non-hardened installs are unchanged (a login-home projects root is fine and kept).
