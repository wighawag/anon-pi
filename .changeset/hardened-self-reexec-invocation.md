---
"anon-pi": minor
---

feat(hardened): add the PURE self-re-exec invocation core for the dedicated `anon` account deployment. New pure `shouldRedirectToAnon` predicate (always-redirect on a hardened install, loop-guarded so a caller already running as `anon` does not re-exec) plus `buildAnonSudoArgv` (the login `sudo -u anon -i <anon-pi> …` form) and `buildAnonSuFallback` (the `su - anon -c '…'` fallback string). The "am I anon?" identity and the anon-pi binary path are INJECTED seams; anon-pi only ever emits a `sudo`/`su` argv (no uid change, no setuid, no spawn here — cli.ts wires the exec in a later task). Records the durable decisions in ADR-0006 and pins the `anon` account / hardened-deployment / self-re-exec vocabulary in `CONTEXT.md`. No change to the normal (non-hardened) launch path.
