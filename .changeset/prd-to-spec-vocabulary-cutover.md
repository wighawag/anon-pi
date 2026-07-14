---
'anon-pi': patch
---

Vocabulary cutover `prd` -> `spec` in the package's source and test comments.

Comment-only sweep: renames the retired `prd` artifact noun to `spec` in `src/*.ts` and `test/*.ts` comments (originating-artifact cross-references), leaving all hyphenated slugs, symbols, and cross-repo references (e.g. the netcage `uid-scoped-graphroot-multi-user-fix` artifact) untouched. No runtime code, exported surface, or behaviour changes; all 731 tests unchanged and green.
