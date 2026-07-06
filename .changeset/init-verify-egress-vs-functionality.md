---
'anon-pi': minor
---

init: don't trap the proxy step on a non-anonymity `netcage verify` failure.

`netcage verify` runs several assertions and exits non-zero if ANY fails. init keyed off that aggregate exit code, so a functionality failure (e.g. netcage 0.11.0's `dns-resolves-over-tcp-glibc`) would block proxy selection even though the forced-egress exit-IP proof (`forced-egress-exit-ip-differs-from-host`) PASSED and the proxy is genuinely anonymizing.

init now distinguishes the two. New pure `verifyEgressAssertionPassed` (a targeted scan for the `[PASS]` egress-assertion line; the assertion id is pinned by a test) gates the behaviour:

- egress assertion PASS but verify exited non-zero (a non-anonymity failure, most likely an in-jail DNS/functionality issue, which is netcage-side): init shows the output and offers a deliberate proceed-anyway prompt, defaulting to NO.
- egress assertion ABSENT or FAIL (a real anonymity failure, or netcage could not prove egress): no override, re-pick the proxy as before.

The anonymity proof stays load-bearing and is never bypassable; this only stops a functionality assertion from trapping the user. anon-pi still touches no netcage invariant.
