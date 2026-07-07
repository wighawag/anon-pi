---
'anon-pi': minor
---

Hardening now requires a system-wide anon-pi, and refuses a per-user (Volta/nvm) install instead of failing after the sudo prompt.

The dedicated `anon` account runs anon-pi as itself (`sudo -u anon -i anon-pi ...`), so anon-pi must live where that account can execute it. A per-user Node manager (Volta, nvm, asdf, fnm) installs anon-pi under the login home (e.g. `~/.volta/bin/volta-shim`), which the `anon` account cannot traverse or run. Previously this produced `Permission denied` AFTER the password prompt, and worse, baked a root sudoers rule pointing at that login-user-writable path (a privilege-scoping hole).

Now:

- The hardened preflight (used by `init` and `persona add`) gains an `anon-pi-binary` check via the new pure `crossAccountBinaryUnsuitable` (rejects a path under the login home, a version-manager shim, a `.js` entry, or nothing). It fails loudly and early with remediation: install anon-pi system-wide (on `/usr/local/bin` or `/usr/bin` via a system Node) and remove the per-user copy. This is hardening-only: a non-hardened anon-pi via Volta/nvm is unaffected.
- `buildTier2ProvisioningScript` refuses to emit a sudoers rule scoped to an unsuitable/login-home anon-pi path (closes the caller-writable-target hole), and now includes a system-wide netcage install (`curl -fsSL .../install.sh | PREFIX=/usr/local/bin sh`), since netcage's default `~/.local/bin` install is also unreachable cross-account.
- On every hardened execution, the login-side anon-pi forwards its version across the crossing; the account-side child refuses on a version mismatch (a per-user vs system install divergence), so the two never silently differ.
