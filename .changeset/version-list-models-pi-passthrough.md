---
'anon-pi': minor
---

Add `--version`, `--list-models`, and the `anon-pi pi <args…>` passthrough.

- **`anon-pi --version` / `-V`** prints anon-pi's own version (it previously
  errored). For pi's version inside the jail, use `anon-pi pi --version`.
- **`anon-pi --list-models` / `--models`** lists the models pi sees, with no
  project needed (a pi query that prints and exits).
- **`anon-pi pi <args…>`** is a general passthrough: run pi inside the jail with
  ANY args and no project (`anon-pi pi --model x`, `anon-pi pi --export out.html
  --session <id>`), so anon-pi never has to special-case each pi flag. `pi` is
  reserved as a project name so the token cannot be shadowed.

These slot into the same no-project pi-launch mechanism as `--session` (cwd at
the projects root, interactive unless `-p`/`--print` is forwarded, forced-egress
jail intact). Combined pi flags already work everywhere:
`anon-pi --session <id> --model qwen`, `anon-pi recon --model x --thinking high`.
