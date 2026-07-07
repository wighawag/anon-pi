# 2026-07-07 — netcage 0.11.0 verify fails `dns-resolves-over-tcp-glibc`; init over-coupled to its exit code

## Field report

On a real box, `anon-pi init` (0.23.1) rejected a working Tor proxy at the proxy step. `netcage verify --proxy socks5h://127.0.0.1:9050` output:

```
proxy: socks5h://127.0.0.1:9050 (source: flag)
[PASS] forced-egress-exit-ip-differs-from-host: jail exit IP 64.190.76.2 differs from host 147.147.37.112 (forced egress active)
[FAIL] dns-resolves-over-tcp-glibc: glibc getaddrinfo could NOT resolve one.one.one.one in the jail: the in-jail DNS forwarder is not answering over TCP (resolv.conf sets use-vc). A UDP-only forwarder breaks glibc images; check netcage-dns.
netcage 0.11.0
```

The ANONYMITY proof (`forced-egress-exit-ip-differs-from-host`) PASSES; only the glibc-DNS-over-TCP functionality assertion FAILS. netcage exits non-zero, and `init` keyed off the exit code (`verify.status !== 0`), so it hard-blocked proxy selection.

## Why it surfaced now (sequencing insight from the user)

`init`'s proxy VERIFY (step 1) runs BEFORE the hardening PREFLIGHT (step 4), and only the preflight requires netcage `>= 0.11.0` (`NETCAGE_MIN_VERSION`, the uid-scoped store). So the user's first, successful `init` verified the proxy on netcage **0.10.0** (which had no DNS-over-TCP assertion), THEN was told to upgrade to 0.11.0 for hardening. On re-run, step 1 verify now runs the STRICTER 0.11.0 assertions and fails. So "it used to work" = it used to verify on 0.10.0. Not an anon-pi regression in anonymity; a netcage assertion that did not exist before + an ordering that tests verify before the version floor is enforced.

## anon-pi side (DONE this session)

`init`'s proxy step no longer hard-blocks on netcage's aggregate exit code. New pure `verifyEgressAssertionPassed` (targeted scan for `[PASS] forced-egress-exit-ip-differs-from-host`, id pinned in a test) splits the two cases:

- egress assertion PASS but verify exited non-zero (a NON-anonymity failure, e.g. DNS): show the output, explain it is likely an in-jail DNS/functionality issue (netcage-side), and offer a DELIBERATE proceed-anyway `[y/N]` (default NO). The anonymity proof held, so the user is not trapped.
- egress assertion ABSENT or FAIL: NO override, force a re-pick (a real anonymity failure or netcage could not prove egress).

This keeps the anonymity check load-bearing (never bypassable) without conflating it with functionality. Does NOT weaken any netcage invariant (anon-pi never touches netcage's DNS).

## netcage side (OPEN — investigate separately)

Is the DNS-over-TCP failure REAL or a probe artifact? The user has been making web requests through anon-pi successfully, which suggests UDP DNS works in practice; only the forced-TCP path (jail `resolv.conf` `use-vc`) fails. netcage's own message points at `netcage-dns`. Open questions for the netcage repo (separate tool, not this repo):

- Why does netcage set `use-vc` (force DNS over TCP) in the jail `resolv.conf` if its in-jail forwarder (`127.0.0.1:53`, known to anon-pi) only answers UDP?
- Is the forwarder actually UDP-only, or is TCP being dropped somewhere (nftables/netns)?
- Does this actually break glibc images (Debian/`node:*-slim`, e.g. the webveil image) in practice, or only the probe? A quick in-jail check: `getent hosts one.one.one.one` and `curl https://example.com` from a glibc jail.

If real, the fix belongs in netcage (its DNS forwarder must answer over TCP, or it must not set `use-vc`). anon-pi must NOT work around it (never weaken forced egress / DNS). Related idea already on file: `work/notes/ideas/consume-netcage-verify-json.md` (consume `verify --json` so anon-pi reasons over assertions structurally instead of scraping `[PASS]`/`[FAIL]` prose - would make the split above robust to wording changes).

## RESOLVED (2026-07-07): DNS was NEVER broken - a false negative from an image pull

Investigated in the netcage repo. Definitive diagnosis (with source evidence + a reproduced PASS, zero DNS code changed):

- The in-jail DNS forwarder DOES listen on TCP (`dnsforwarder.Start` binds UDP + TCP; `serveTCP`/`handleTCPConn` present in the installed v0.11.0 `netcage-dns`).
- The firewall PERMITS loopback TCP :53 (no DROP for it, OUTPUT policy stays ACCEPT); `nc -z 127.0.0.1 53` is open in a real jail.
- `use-vc` is intentional + correct (egress UDP is hard-dropped, so glibc must use TCP).
- glibc `getaddrinfo` over TCP WORKS in practice (Debian/`node:*-slim` resolve fine).

Root cause: the `dns-resolves-over-tcp-glibc` assertion stands up a real jail using a ~950 MB `buildpack-deps` glibc probe image. On the uid-scoped store that image was absent, so it was PULLED THROUGH THE SOCKS/Tor PROXY, blowing the 3-minute verify budget. The probe then saw EMPTY output and mis-collapsed "probe produced no output" into the specific claim "the forwarder is not answering over TCP." So it was over-strict (option d), NOT a real DNS/forwarder/firewall bug. The user's web usage worked all along because their tool image was already local (no in-jail pull).

netcage-side fix (implemented in the netcage repo, both parts of d): pre-pull / shrink the DNS-probe image so it is not fetched through the proxy, and split the failure message so "image pull/timeout" is reported honestly instead of a scary "TCP DNS broken."

anon-pi-side (0.24.0 `verifyEgressAssertionPassed` + proceed-anyway): KEPT - the design is still correct (anonymity proof is load-bearing; a genuine non-egress assertion should not trap the user). Only the WORDING was made neutral (0.25.x): it no longer presumes the non-egress failure is DNS, and points the user at the SPECIFIC assertion, since netcage now distinguishes a probe/pull failure from a real functionality failure.

Net: nothing broken on your box; the proxy anonymizes and DNS resolves. With updated netcage the assertion will PASS (or fail honestly on a slow pull). anon-pi will not trap you either way.
