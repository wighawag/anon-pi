---
'anon-pi': minor
---

Forward pi's session-resume flags, so `anon-pi --session <id>` works.

pi prints `To resume this session: pi --session <id>` on exit. That command is
now usable by just prefixing `anon-pi`:

- `anon-pi --session <id>` / `--session-id <id>` / `--resume` (`-r`) /
  `--continue` (`-c`) / `--fork <id>` launch pi with NO anon-pi project and
  forward the flag(s) verbatim. pi resolves the session by id (session files live
  in the always-mounted machine home) and switches to its own project cwd, so no
  project is needed. `-m <machine>` before the flag still picks the machine.
- Fixed the no-TTY discipline: a forwarded run is treated as HEADLESS (no TTY
  required) ONLY when it forwards pi's `-p`/`--print`. Other forwarded flags
  (e.g. `--session`, `--model`) stay INTERACTIVE and keep the TTY + `-it`
  (previously any forwarded arg was wrongly treated as headless).
- `--shell` + a session flag is a clear error (a shell has no session to resume).
