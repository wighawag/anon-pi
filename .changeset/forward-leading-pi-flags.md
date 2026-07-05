---
'anon-pi': minor
---

Forward a leading pi flag straight to pi when there is no project, so the
explicit `pi` token is no longer required for the common case. Any flag anon-pi
does not itself own, seen in the no-project position, is now handed to pi
verbatim (that flag plus everything after it):

- `anon-pi -p "hello world"` == `anon-pi pi -p "hello world"`
- `anon-pi --model qwen3-coder` == `anon-pi pi --model qwen3-coder`

anon-pi still captures its OWN flags first (`-m`/`--machine`, `--shell`,
`--mount`, `-i`/`--image`) and the subcommand nouns (`machine`, `image`,
`container`, `init`, `forward`, `ports`), so those keep working and compose
(`anon-pi -m webveil -p "hi"`). The retired `--keep`/`--rm` and the
needs-a-project `--fork`/`--continue` keep their existing helpful errors. The
explicit `anon-pi pi <args…>` passthrough still works as an equivalent, clearer
spelling.

BREAKING: an unrecognised leading flag no longer errors with "unknown option";
it is forwarded to pi, which rejects a genuinely bogus flag itself.
