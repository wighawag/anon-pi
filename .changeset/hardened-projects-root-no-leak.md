---
'anon-pi': minor
---

init: harden the projects-root choice against a login-username leak, and make the hardening choice explicit.

- The hardened-deployment question now runs BEFORE the projects-root step (it was last), so the projects-root step knows whether the install is hardened.
- On a hardened install the projects root now defaults to the `anon` account's tree, and a path under the login home is REFUSED. The projects root is the host bind-mount source for `/projects`, so a login-home path would leak the login username (through the mount source and file ownership) into the anon-run jail, defeating the dedicated account. New pure `projectsRootLeaksLogin` encodes the check (separator-aware, so a prefix-sharing sibling like `/home/user-old` is not treated as under `/home/user`).
- The hardening question has NO default: it requires an explicit `y`/`n`, and an empty answer re-asks rather than silently declining. Ctrl-C/EOF aborts init as before.
- The "already hardened, skip the question" check is now persona-aware (`isAnonPersonaAccount`): it recognizes running under a namespaced `anon-<name>` account, not only the bare `anon`.
