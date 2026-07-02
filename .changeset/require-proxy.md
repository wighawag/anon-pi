---
'anon-pi': minor
---

Make `ANON_PI_PROXY` required; remove the `socks5h://127.0.0.1:9050` default.
anon-pi is an anonymity tool, so the proxy is the single most important input and
must never be guessed: a silent default can anonymize through the wrong endpoint
(or none) and fail confusingly deep in the jail. It now errors like
`ANON_PI_IMAGE`/`ANON_PI_LLM` when unset, mirroring netcage, which itself refuses
to run without `--proxy` (fail-closed).
