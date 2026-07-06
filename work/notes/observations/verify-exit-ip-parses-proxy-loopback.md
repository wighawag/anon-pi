---
title: `init` shows "Exit IP: 127.0.0.1" - parseVerifyExitIp grabs the proxy address, not the exit IP
slug: verify-exit-ip-parses-proxy-loopback
---

# `init` reports the loopback proxy address as the "Exit IP"

Spotted in the field (anon-pi@0.21.0). During `init`'s proxy step, with a normal loopback proxy (`socks5h://127.0.0.1:9050`, e.g. Tor), anon-pi printed:

```
Verifying via netcage: netcage verify --proxy socks5h://127.0.0.1:9050
  Exit IP (via the proxy, NOT your host): 127.0.0.1
```

`127.0.0.1` is the PROXY's loopback address, NOT an anonymized exit IP. A healthy verify should show a PUBLIC exit IP (the Tor/VPN exit). This is a false alarm in the one tool whose whole job is trust in anonymized egress: every hardened/Tor user with a loopback proxy (the normal case) sees this and reasonably fears their anonymization is broken.

## Mechanism (verified against both sources, NOT egress-broken)

It is a PARSE/DISPLAY bug in anon-pi, not a proxy or leak problem.

- anon-pi runs `netcage verify --proxy <url>` and calls `parseVerifyExitIp(output)` (`packages/anon-pi/src/anon-pi.ts` ~line 3222), which grabs the FIRST IPv4 literal in netcage's combined output.
- `netcage verify`'s output (`internal/verify/verify.go` `Report.String()`) prints the proxy line FIRST: line 84 `fmt.Fprintf(&b, "proxy: socks5h://%s", r.Proxy.Address())` => `proxy: socks5h://127.0.0.1:9050`. So the FIRST IPv4 in the output is `127.0.0.1` (the proxy), which parseVerifyExitIp latches onto.
- The REAL exit IP is later, embedded in an assertion Detail (verify.go line 311): `[PASS] forced-egress-exit-ip-differs-from-host: jail exit IP <REAL-IP> differs from host <HOST-IP> (forced egress active)`.

So anon-pi grabs the proxy address from the first line instead of the jail exit IP from the assertion line. Egress is fine (netcage's `forced-egress-exit-ip-differs-from-host` assertion is what actually proves it); only anon-pi's displayed number is wrong.

## Root cause is an ANTI-PATTERN: anon-pi re-derives + string-scrapes a value netcage already presents

The deeper issue (surfaced by the user) is not just the regex - it is that `init` re-implements netcage's exit-IP display by SCRAPING it out of prose and REPRINTING it as its own one-liner. Two better designs, both of which kill the bug CLASS rather than patch the regex:

1. **Just STREAM netcage's output instead of parsing it.** netcage already prints an unambiguous, MORE trustworthy line: `[PASS] forced-egress-exit-ip-differs-from-host: jail exit IP <real public IP> differs from host <host IP> (forced egress active)`. Showing that verbatim (instead of anon-pi's re-labelled `Exit IP: X` summary) is clearer AND impossible to mislabel. The only reason anon-pi parses is to show a tidy onboarding one-liner - and that "tidiness" is exactly what broke and scared the user. Strongly consider dropping the parse and streaming `verify`'s human output (or streaming it AND dropping the summary line).
2. **If a machine-readable value IS wanted, netcage should offer `verify --json`, not force prose-scraping.** netcage ALREADY has a JSON convention - `detect-proxy --json` and `ports --json` emit a machine contract (which is exactly why anon-pi consumes `detect-proxy --json` cleanly elsewhere and does NOT scrape it). But `verify` has NO structured output (only `Report.String()` prose, `internal/verify/verify.go`), so anon-pi is FORCED to string-scrape it. The principled fix is a CROSS-REPO pair:
   - **netcage:** add `verify --json` (consistent with `detect-proxy`/`ports`) emitting the structured report incl. explicit `jailExitIp` + `hostExitIp` fields. A tool whose output another tool consumes should offer a stable contract, not prose.
   - **anon-pi:** consume `verify --json` like it already does `detect-proxy --json`, instead of regex-scraping.

## Two fixes at two severities

- **Immediate (anon-pi only, cheap, unblocks users now):** make `parseVerifyExitIp` not grab the proxy line - skip any IP on a line starting `proxy:`, or parse the `forced-egress-exit-ip-differs-from-host` assertion Detail ("jail exit IP <IP> differs from host <IP>") and return the JAIL IP. OR (cleaner) drop the parse and stream netcage's output. Add a unit test with a REAL `netcage verify` sample (proxy line = loopback + the forced-egress assertion carrying a public jail IP) asserting the result is the PUBLIC ip, not `127.0.0.1`. The existing parseVerifyExitIp tests lacked a sample where the proxy line's IP precedes the exit IP - add that case.
- **Durable (cross-repo, better, removes the scrape class):** `netcage verify --json` + anon-pi consuming it. Matches netcage's own `--json` convention; `verify` was just never brought up to it. Belongs partly in the netcage repo (its forced-egress/output contract), so it wants netcage's own review.

General lesson (both this project's grain and a good one): do NOT string-scrape another tool's human prose; either stream it verbatim, or consume a structured contract it offers. anon-pi already follows this for `detect-proxy --json`; the `verify` exit-IP path is the one place it regressed to scraping, and it bit exactly where trust matters most.

## Severity

High-visibility, low-risk-to-fix, and SCARY to users (looks like an anonymization failure during onboarding). Worth a prompt patch. Purely cosmetic (no egress/leak impact), but it undermines trust exactly where trust is the product.
