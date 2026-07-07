---
'anon-pi': minor
---

init: ask hardening FIRST, show only the still-needed root commands, and add color + clearer section headers.

- **Hardening is now Step 1** (was Step 4). It is the most likely step to block (it needs a system-wide anon-pi + netcage and a provisioned account), so asking + running its preflight first means you find out before investing in the proxy/model/image steps, and every later step is hardened-aware from the start.
- **The Tier-2 root command block is filtered to only what is missing.** Previously it always printed every step (`useradd`, `loginctl enable-linger`, netcage install, sudoers) even when the check for that step already passed; a re-run whose account already existed still showed `useradd -m anon`. Now the block emits only the steps whose preflight check failed (renumbered with no gaps); the sudoers step is always emitted (idempotent, no probe). New pure `tier2NeedsFromFailures` maps failing check ids to needed steps.
- **Clearer + colored onboarding.** Section headers are titled/ruled, the "what is still needed" failures are listed above the commands, and output is colored (bold/cyan titles, green success, yellow/red warnings), gated on the stdout TTY + `NO_COLOR` so pipes and `NO_COLOR` stay plain.
