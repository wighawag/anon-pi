---
'anon-pi': minor
---

Add `--mode text-stream`: watch a headless one-shot's progress live

A plain `-p` run prints only pi's final answer, so a long run looks frozen
while the agent works. The new anon-pi-owned mode value streams it:

  anon-pi <project> -p --mode text-stream "..."

anon-pi strips the `text-stream` token, runs pi with `--mode json` inside the
jail, parses that JSONL event stream on the host, and renders a readable
per-turn view (each assistant message, plus a `> <tool>` line per tool call) to
stderr, while pi's final answer still goes to stdout so the run stays pipeable.

`text-stream` is anon-pi-owned: it requires `-p` and cannot be combined with
another `--mode` (anon-pi owns the mode to drive the stream). Any other `--mode`
value is still forwarded to pi verbatim. Interactive launches are unaffected.
