---
'anon-pi': patch
---

Make the missing-`ANON_PI_IMAGE` error copy-pasteable. The previous version
printed an indented `Dockerfile.pi` heredoc, so pasting it baked leading spaces
into the file and broke the `EOF` terminator. Now the error points at the
`Dockerfile.pi` that ships with the package (resolved to its real absolute path)
and emits a flush-left `podman build` + `export` you can paste as-is.
