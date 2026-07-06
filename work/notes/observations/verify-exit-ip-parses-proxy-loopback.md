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

## Fix shape

Make `parseVerifyExitIp` extract the JAIL exit IP, not the first IPv4:

- SKIP the `proxy:` line (ignore any IP on a line starting `proxy:`), OR
- specifically parse the `forced-egress-exit-ip-differs-from-host` assertion Detail ("jail exit IP <IP> differs from host <IP>") and return the JAIL IP, OR
- more robustly, have netcage emit the exit IP on an unambiguous labelled line (a cross-repo option; netcage's `Report.String()` could print e.g. `exit-ip: <IP>` so consumers do not string-scrape assertion prose). The anon-pi-only fix (skip the proxy line / read the assertion) is enough and needs no netcage change.

Add a unit test with a REAL `netcage verify` output sample (proxy line = loopback + the forced-egress assertion carrying a public jail IP) asserting parseVerifyExitIp returns the PUBLIC ip, not `127.0.0.1`. The existing parseVerifyExitIp tests evidently did not include a sample where the proxy line's IP precedes the exit IP - add that case.

## Severity

High-visibility, low-risk-to-fix, and SCARY to users (looks like an anonymization failure during onboarding). Worth a prompt patch. Purely cosmetic (no egress/leak impact), but it undermines trust exactly where trust is the product.
