---
"anon-pi": patch
---

docs(prd): task the hardened dedicated-account deployment PRD. Design-only, no runtime change. Narrows v1 to init-driven hardening (no separate `harden` verb, no `--hardened` flag), replaces the `anon` wrapper with self-re-exec (always-redirect on a hardened install), and clears the open question by deferring the standalone `harden` verb + workspace migration to a new idea note. Emits five ready tasks (self-re-exec invocation, preflight, Tier-2 script generator, init provisioning step, docs) and moves the PRD to `work/prds/tasked/`.
