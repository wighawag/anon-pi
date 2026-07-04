---
'anon-pi': minor
---

Land the bare-launch **interactive menu**: bare `anon-pi` (and bare `-m
<machine>` / `--mount <parent>` with no project) now shows a host-side arrow-key
menu BEFORE any jail runs, and launches the chosen thing on Enter.

The menu is a PURE host-side read (no jail runs until you pick): it lists the
active root's projects (`readdir`) plus each machine's pi session dirs
(`readdir`) and feeds them to the pure `buildMenuChoiceList` /
`deriveProjectUsage` / `buildMenuEntries`. Each project row is ANNOTATED with the
machines it has been used on and flags whether the current machine is new for it
(`used on: <machines>; new here`), derived from session-dir presence, no marker
file. Conversations are per-machine, project files are global.

Selection dispatches to the SAME launch paths as the equivalent typed command
(re-resolved through `resolveRunPlan` + a shared `executeLaunchPlan`, so a menu
pick launches byte-for-byte identically): a project or the `.` "here" entry -> pi
(`/projects/<name>` or the root itself); `+ new project…` -> prompt + validate a
name (`validateName`) then pi; `shell` -> the `--shell` jailed bash.

The selector is a HAND-ROLLED, zero-dependency raw-mode `select()` (a small
supply-chain surface is on-brand for a security tool; the list is short):
up/down (arrows or `k`/`j`) move a `>` cursor over a highlighted row, Enter
selects, Ctrl-C / `q` / Esc cancels, and the terminal is ALWAYS restored (raw
mode off, cursor shown) on every exit path. It is isolated behind a tiny
signature so a prompt lib could swap in later as a localized change. No-TTY reuses
the bare-launch error (the menu never runs without a terminal).

New PURE, unit-tested exports in `src/anon-pi.ts`: `MenuEntry` /
`MenuEntryKind`, `buildMenuEntries`, `formatProjectAnnotation`, and the fixed
labels `MENU_HERE_LABEL` / `MENU_NEW_LABEL` / `MENU_SHELL_LABEL`. ALL the menu's
logic (entry order + annotation wording) lives in the pure module; the raw-mode
render/select is the only untested I/O.
