---
'anon-pi': minor
---

Resume a session in its own project, and make `--fork`/`--continue` require a
project.

- **`anon-pi --session <id>` (and `--session-id`/`--resume`/`-r`) now resume in
  place.** anon-pi looks the session id up in the machine's session store, reads
  the project cwd it belongs to (from the session file's header record), and
  launches pi with `-w <that cwd>`. So pi reopens the conversation directly
  instead of prompting `Session found in different project: … Fork? [y/N]`
  (which happened because anon-pi previously launched pi at the projects root,
  a cwd that never matched the session). An unresolvable id falls back to the
  old behaviour (launch at the projects root, let pi decide), so it is pure
  upside. An explicitly named project still wins (the user is trusted; pi's own
  fork-prompt guards a genuine cwd mismatch).
- **`--fork` and `--continue`/`-c` now require a project.** With no project they
  would land a new (`--fork`) or newest (`--continue`) conversation in the
  projects root by surprise. anon-pi now refuses them without a project and
  points you at a copy-pasteable fix: `anon-pi <project> --fork <id>` (the
  project may be `.` for the root, and is created on demand, so
  `anon-pi newproj --fork <id>` forks into a fresh `/projects/newproj`).
