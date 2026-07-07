---
'anon-pi': patch
---

init: surface the system-wide-anon-pi requirement as its own step, not a root command.

When the only thing blocking hardening was the anon-pi-binary check (e.g. anon-pi is a per-user Volta shim), init still printed the "Root commands to paste (become root FIRST)" block, "Run the commands above in a root shell", and a re-check prompt, even though the only line in that block was `sudo -i` (the sudoers step was a SKIPPED comment) and no root command could fix it. Installing anon-pi system-wide is a login-user action, and a re-check in the same init session can't help (the running process is still the unsuitable binary).

The anon-pi-binary requirement is now handled as its own step, before the root-commands flow: init prints a dedicated "anon-pi must be installed system-wide first" message with the install/remove guidance and asks you to reinstall and re-run init (or `skip` to install non-hardened), rather than telling you to paste commands in a root shell. The Tier-2 root-commands block is only shown when the binary is suitable, so it always contains real commands.
