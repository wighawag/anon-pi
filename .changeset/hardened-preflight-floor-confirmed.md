---
"anon-pi": patch
---

docs(tasks): resolve the hardened-preflight netcage version-floor question. Confirmed the uid-scoped store (netcage ADR-0017) shipped in netcage `v0.11.0` (commit `965c991` is the tip tagged `v0.11.0`; `v0.10.0` still carries the old fixed store), so `>= 0.11.0` is verified. Clear `needsAnswers` on `hardened-preflight-checks` and pin the floor to `0.11.0` (kept as a named constant). Tasking-only, no runtime change.
