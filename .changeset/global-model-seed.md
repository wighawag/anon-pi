---
'anon-pi': minor
---

The local-model seed is now GLOBAL (shared by every machine), not per-`default`.

Because `config.json` holds one `llm` endpoint (the single `--allow-direct` hole,
shared across machines), the generated `models.json` describing it should be
shared too — previously it lived under `machines/default/` and only that machine
got it, so a second machine launched with an empty models list.

- `init` now writes a **global** `~/.anon-pi/models.json` + `settings-seed.json`,
  and updates every ALREADY-seeded machine home in place (conversations
  untouched) so a re-run actually takes effect.
- Every machine's fresh-home seed resolves the global seed by default, with an
  optional per-machine override (`machines/<M>/models.json`) for the rare case
  where a machine points at a different local model.
- Migration: `init` removes the old `machines/default/models.json` +
  `settings-seed.json` it wrote in prior versions, so `default` picks up the
  global seed like every other machine.

This also fixes: re-running `init` now updates an existing home (prior versions
wrote the seed but the marker-guarded first-launch promotion never re-applied it
to an already-seeded home).
