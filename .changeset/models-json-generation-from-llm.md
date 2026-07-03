---
'anon-pi': minor
---

Add a PURE `models.json` generator (`generateModelsJson`) to `src/anon-pi.ts`:
given a single `llm` endpoint (a URL, `ip:port`, or bare ip), it returns a
barebones pi `models.json` carrying exactly ONE local provider pointed at that
endpoint. This replaces the old `import`-from-host-models.json flow as the source
of the seed provider (used by `init` / seed-if-fresh to seed each machine home).

- The endpoint is normalised with the existing `hostPortKey` helper (drops
  scheme / path / `user:pass@`, lowercases), so every endpoint form produces the
  same single-provider output.
- It reads NO host pi `models.json`: no other provider, no paid API key, no
  session identity can leak into the seed (the anonymity hygiene the old `import`
  path preserved is now guaranteed by construction).
- The generated provider uses a neutral, host-agnostic key (`LOCAL_PROVIDER_NAME`
  = `local`), the OpenAI-compatible completions dialect
  (`LOCAL_PROVIDER_API` = `openai-completions`) that local model servers
  overwhelmingly speak, a benign non-secret apiKey (`none`), and a
  `http://<host[:port]>/v1` baseUrl.

This change is ADDITIVE: the legacy `import`-source symbols
(`pickProviderForLlm` / `resolveSourceModelsPath`) and their tests are left in
place (still read by `cli.ts`'s `import` path); their removal is owned by a later
task.
