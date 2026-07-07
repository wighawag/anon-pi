---
'anon-pi': patch
---

init: clearer system-wide-anon-pi guidance when hardening is refused for a per-user (Volta/nvm) install.

The anon-pi-binary remediation now leads with "Because you chose the HARDENED deployment ...", so it is obvious why the requirement applies, and gives a concrete, numbered fix: install Node.js system-wide (noting that a per-user manager like Volta/nvm keeps precedence on your login shell, so a system Node does not disturb your normal workflow), then `sudo npm install -g anon-pi` (which lands on a shared PATH the account can run), then remove the per-user anon-pi (e.g. `volta uninstall anon-pi`) so the login user and the account never run two different versions.
