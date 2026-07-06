---
"anon-pi": patch
---

docs(tasks): fix two review findings in the multi-persona tasks. `persona-as-launch-selection-wiring` no longer asks to reshape the preflight for range-existence/account (already true in v1's `probeHardenedPreflight`/`subidRangePresent`); it now threads the selected persona account to the call site instead. `persona-tier2-commands-generator` now owns the full ripple of removing `SUBID_RANGE_COUNT`/`SUBID_RANGE_START` (reword `subidRemediation`, update `hardened-preflight`/`hardened-orchestrator`/`hardened-provisioning` tests) so the reshape lands green in one step. Tasking-only, no runtime change.
