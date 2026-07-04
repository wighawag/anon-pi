---
'anon-pi': minor
---

`init` now imports real models for the local endpoint (and sets a default).

Previously the generated `models.json` had an empty models list, so pi saw the
provider but had no pickable model. The local-model step now:

- **Merges two endpoint-scoped sources**: the provider in your own
  `~/.pi/agent/models.json` whose baseUrl matches the endpoint (marked
  `[configured]` — your hand-tuned entries, with their `contextWindow`/
  `maxTokens`/etc. preserved) and the endpoint's live `GET /v1/models` (marked
  `[server]`). ONLY the provider served by the endpoint (the one
  `--allow-direct` hole) is ever read, so no other provider — and no other key —
  can enter the seed.
- **Lets you choose** which models to import (Enter/`c` = all configured, `a` =
  all server+configured, numbers, `s` = skip) and **which is the default**.
- Writes `models.json` (the chosen entries under the neutral `local` provider)
  **and** a settings seed that the first-launch promotion merges into the home's
  `settings.json` — setting `defaultProvider`/`defaultModel`/`enabledModels`
  without clobbering image-staged packages/extensions.
- **Refuses a real apiKey by default**: if the matching host provider carries a
  non-benign apiKey, init aborts (a host credential should not enter the anon
  home) unless you pass `--force-allow-local-llm-api-key`, which carries it
  through with a warning.
