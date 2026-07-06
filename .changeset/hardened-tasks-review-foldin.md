---
"anon-pi": patch
---

docs(tasks): fold review findings into the hardened-dedicated-account tasks. Flag `hardened-preflight-checks` with `needsAnswers` because the netcage version floor (`>= 0.11.0`) was unverified against a shipped netcage release; make the floor a to-confirm named constant. Give `hardened-self-reexec-invocation` explicit ownership of the hardened-dedicated-account ADR and the `CONTEXT.md` glossary entries so the vocabulary cannot re-fork. Tasking-only, no runtime change.
