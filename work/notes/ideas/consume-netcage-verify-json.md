---
title: Consume `netcage verify --json` in `init` instead of scraping its prose
slug: consume-netcage-verify-json
---

# Consume `netcage verify --json` instead of scraping prose

Proposed idea. Once netcage ships a machine-readable `verify --json` (netcage idea `verify-json-output-contract`, github.com/wighawag/netcage `work/notes/ideas/verify-json-output-contract.md`), switch anon-pi's `init` proxy step from STRING-SCRAPING `netcage verify`'s human output to CONSUMING its `--json` contract - exactly as `init` already consumes `netcage detect-proxy --json` cleanly.

## Why

`init` shows the user their anonymized exit IP as proof of forced egress. It currently runs `netcage verify --proxy <url>` and pulls the exit IP out of the prose via `parseVerifyExitIp` (`packages/anon-pi/src/anon-pi.ts`). That scrape shipped a scary field bug (anon-pi@0.21.0): netcage prints the proxy URL first (`proxy: socks5h://127.0.0.1:9050`), so the naive first-IPv4 grabbed the loopback PROXY address and displayed `Exit IP: 127.0.0.1`, looking like an anonymization failure. See `work/notes/observations/verify-exit-ip-parses-proxy-loopback.md`.

That bug is already PATCHED (parseVerifyExitIp now skips the proxy line + `init` streams netcage's real output). This idea is the DURABLE follow-up: stop parsing prose entirely. anon-pi already has the right pattern - it consumes `detect-proxy --json` structurally and does NOT scrape it - so the exit-IP path is the one place it regressed to prose-scraping. Consuming `verify --json` removes the fragile-parse class for good.

## Shape

- Replace the `parseVerifyExitIp(output)` prose scrape with a parse of `netcage verify --json`'s structured report: read the explicit `jailExitIp` (+ `hostExitIp`) fields and the per-assertion pass/fail, mirroring how `init` already parses `detect-proxy --json`.
- Keep showing netcage's evidence to the user (the forced-egress assertion result); the JSON just makes the exit IP unambiguous instead of regex-guessed.
- `parseVerifyExitIp` (and its tests) can then be RETIRED, or kept only as a fallback for an older netcage without `verify --json` (probe the verb's `--help` / schema, the way anon-pi already tolerates netcage version differences elsewhere).

## Blocked-on / cross-repo

- BLOCKED-ON netcage shipping `verify --json` (netcage idea `verify-json-output-contract`). Until then, the shipped stopgap (skip-the-proxy-line parse + stream netcage's output) stands.
- Preflight/version note: like the multi-persona netcage `>= 0.11.0` floor, consuming `verify --json` implies a minimum netcage version that HAS it; gate/fallback accordingly.

## Open threads

- Whether to hard-require the `verify --json`-capable netcage (bump the floor) or keep the prose fallback for older netcage.
- Exact field names to consume (track netcage's `verify-json-output-contract` schema decision).
