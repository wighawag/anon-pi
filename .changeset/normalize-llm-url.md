---
'anon-pi': patch
---

Accept a URL-form `ANON_PI_LLM`. netcage's `--allow-direct` wants a bare
`IP[:port]`/CIDR, but users naturally set `ANON_PI_LLM` to a URL like
`http://192.168.1.150:8080`. anon-pi now strips the scheme/path (the same
normalization `import` already uses) before passing it to `--allow-direct`, so a
URL, an `ip:port`, or a bare IP all work.
