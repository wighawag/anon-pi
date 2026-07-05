---
"anon-pi": patch
---

docs(prd): add the hardened dedicated-account deployment PRD (proposed). Design-only artifact under `work/prds/proposed/`; no runtime change. Captures running anon-pi under a single dedicated `anon` Unix account, invoked from the login user via `sudo -u anon -i`, with a two-tier "actively help, never silent root" provisioning flow (Tier 1 rootless setup + preflight; Tier 2 generated root script). One open question (the existing-workspace migrate default) still blocks tasking.
