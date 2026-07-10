---
'anon-pi': minor
---

Adopt netcage's `--allow-direct` -> `--allow` flag rename and require netcage >= 0.12.0.

netcage v0.12.0 renamed its split-tunnel flag `--allow-direct` -> `--allow` (and made it port-mandatory), so anon-pi now composes the one direct hole as `--allow <host:port>` on every launch path (`run` and `container enter` -> `netcage start`); the direct target is unchanged (still the ONE hole, always present with `--proxy`). The `NETCAGE_MIN_VERSION` floor moves `0.11.0` -> `0.12.0`, now enforced for TWO reasons (the uid-scoped store from 0.11.0 AND the `--allow` flag from 0.12.0). A LAUNCH-TIME gate at the spawn seam refuses a jail-entering launch on netcage `< 0.12.0` (or absent/unparseable) with the upgrade remediation and a non-zero exit BEFORE spawning netcage with the new flag, so a non-hardened install gets clear guidance instead of a raw `unknown flag "--allow"`.

This is a deliberate BACKWARD-INCOMPATIBLE bump: anon-pi supports netcage >= 0.12.0 only (no dual-flag support, no version-conditional argv). Upgrade netcage to >= 0.12.0.
