---
"anon-pi": patch
---

docs(prd): add the multi-persona hardened-accounts PRD (proposed) + a GUI-via-virtual-screen idea note. Design-only, no runtime change. Generalizes the single `anon` account (v1) into N dedicated persona accounts, each with its own mode-700 home and fail-closed per-persona egress (Tor multi-persona via SOCKS-username isolation, or bring-your-own SOCKS), `anon` staying the default; supersedes ADR-0006's single-account framing. Selection is a typed interactive prompt (name kept out of logs) with a `--as` escape hatch; `persona add` provisions via a root-shell-first neutrally-named script. Persona identity (email/git) is out of scope (configured in-home); GUI is a linked idea note.
