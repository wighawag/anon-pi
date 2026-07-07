---
'anon-pi': patch
---

Fix `-p --mode text-stream` so it renders each turn LIVE as it happens, not all at once at the end. The WATCH path used `spawnSync`, which buffers pi's entire JSONL stdout and only returns it on child exit, so every step surfaced at the very end. It now uses an async `spawn` with an incremental `stdout` handler, so each complete line renders the instant it arrives. The final answer is still printed to STDOUT on exit (pipeable), stdin/stderr stay inherited, and the exit code still propagates.
