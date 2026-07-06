---
title: Keep persona names out of shell history (typed prompt instead of argv) - maybe later
slug: persona-name-history-hygiene
---

# Keep persona names out of shell history - maybe later

Deferred out of the `multi-persona-hardened-accounts` PRD. During that design we considered making persona selection an interactive TYPED prompt (so the persona name never lands in shell history / `ps` argv / audit logs) with `--as <name>` only as an opt-in escape hatch. We DROPPED it for v1: the name is already visible in `/etc/passwd`, the sudoers file, the home dir path (`~anon-<name>/`), and every `ps` line of the running persona's own processes, so protecting it in the LOGIN shell's history specifically is a narrow, low-value benefit that did not justify making an interactive prompt the primary path (and a `--as` flag people would use daily anyway defeats it for heavy users).

So v1 takes the name as a plain argument: `anon-pi --as <name> …` and `anon-pi persona add <name>`. The name may appear in shell history; that is accepted.

## The idea, if ever wanted

If history-hygiene of persona names later turns out to matter, add an OPTIONAL typed-prompt mode: `anon-pi --as` (no value) or a config toggle makes anon-pi PROMPT for the persona name interactively (read from the tty, never echoed to argv), so a shell-history/`ps` scrape does not reveal which persona was launched. `--as <name>` stays as the fast path for people who do not care.

## Why it is low priority

- The benefit is confined to the login user's OWN shell history / process args; the name is unavoidably elsewhere (passwd, sudoers, home path) and root can always enumerate personas.
- Heavy users will use the flag form regardless, so the protection mostly helps casual use, which is fine either way.
- It adds a prompt path + non-TTY handling + the "re-ask on typo" apparatus for a small gain.

Pick it up only if a concrete threat (someone scrapes your shell history and the persona NAME itself is the sensitive leak) materializes.
