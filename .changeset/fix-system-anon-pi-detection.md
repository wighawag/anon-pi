---
'anon-pi': patch
---

Fix hardening falsely rejecting a correctly system-installed anon-pi (Volta users).

Two detection bugs made hardening refuse even after `sudo npm install -g anon-pi`:

- **It resolved the binary via the login user's PATH**, where a per-user Node manager (Volta/nvm) prepends its own dir, so `command -v anon-pi` returned the per-user shim (e.g. `~/.volta/bin/volta-shim`) instead of the system `/usr/local/bin/anon-pi`. anon-pi now resolves the binary the way the `anon` account would, in a SANITIZED login shell (`env -i ... sh -lc 'command -v anon-pi'`, which loads the SYSTEM login PATH from `/etc/profile`), so it finds the system install even while Volta is still present. It also no longer realpaths the result, keeping the stable `/usr/local/bin/anon-pi` symlink so the sudoers rule survives version bumps.
- **It rejected a `.js` path as non-executable.** A system npm-global bin is a symlink to a root-owned, world-executable `dist/cli.js` with `#!/usr/bin/env node`, which the account runs fine. The `non-executable-js` reason is removed; the load-bearing disqualifiers stay (under the login home, or a version-manager shim).

The anon-pi-binary step is now resumable too: install anon-pi system-wide and press Enter to re-check (it finds the system one immediately), instead of aborting init.
