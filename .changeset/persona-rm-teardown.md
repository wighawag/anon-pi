---
'anon-pi': minor
---

Add `anon-pi persona rm [<name>]`: print the root teardown commands for a persona.

The mirror of `persona add`. It PRINTS the root commands to tear a persona down (remove its scoped sudoers rule, `loginctl disable-linger`, then `userdel -r anon-<name>`) for you to paste into a root shell; anon-pi never runs them (consistent with the "print Tier-2, never sudo" principle). A bare `rm` targets the default `anon`.

`userdel -r` deletes the account's mode-700 home and ALL its anonymized session transcripts (irreversible), so it is gated: on a TTY it asks you to type the account name to confirm before printing (or pass `--yes`); without a TTY it refuses unless `--yes`. If the account does not exist it says so and the printed commands are harmless no-ops (handy to clean a leftover sudoers rule). New pure `buildPersonaTeardownScript` (ordered so the sudoers rule is removed and linger disabled before `userdel`, testable as a string) and the `rm` grammar in `parsePersonaArgs`.
