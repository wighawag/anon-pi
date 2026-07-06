---
"anon-pi": patch
---

fix(init): stop reporting the loopback proxy address as the "Exit IP". `netcage verify` prints the proxy URL (`proxy: socks5h://127.0.0.1:9050`) on its first line, so `init`'s naive first-IPv4 scrape reported `127.0.0.1` as the exit IP, a scary false alarm suggesting anonymization had failed. `parseVerifyExitIp` now skips the proxy line and reads the real jail exit IP from netcage's forced-egress assertion, and `init` now streams netcage's own verify output as the authoritative evidence (so a parse miss can never masquerade as the exit IP). No egress/behaviour change; display only.
