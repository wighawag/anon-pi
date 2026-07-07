---
'anon-pi': patch
---

init: neutral wording for a non-egress `netcage verify` failure.

The investigation into the `dns-resolves-over-tcp-glibc` FAIL found it was a false negative (the ~950 MB glibc probe image was pulled through the proxy and blew the verify budget; DNS/forwarder/firewall were all fine), and netcage now distinguishes a probe/pull failure from a real functionality failure. init's proceed-anyway prompt no longer presumes the non-egress failure is a DNS issue; it points the user at the specific failed assertion in netcage's output. No behaviour change: the egress exit-IP proof stays load-bearing and a genuine non-egress failure still offers a deliberate proceed-anyway (default no).
