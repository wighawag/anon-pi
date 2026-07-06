---
"anon-pi": patch
---

docs(prd): simplify the multi-persona hardened-accounts PRD. Drop the stored used-SOCKS list (decision 6) down to a one-line BYO warning; drop the typed-selection-prompt privacy machinery in favour of a plain `--as <name>` flag (default `anon`), deferring the history-hygiene variant to a new idea note; retire the generated `#!/bin/sh` script FILE in favour of printed copy-paste commands run in a root shell entered first (no on-disk file); and add the `anon-<name>` account-prefix decision (user types the bare `<name>`, default is bare `anon`). Tasking-only, no runtime change.
