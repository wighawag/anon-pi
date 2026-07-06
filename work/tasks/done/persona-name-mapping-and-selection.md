---
title: Persona name<->account mapping, --as selector, and generalized self-re-exec loop guard (pure)
slug: persona-name-mapping-and-selection
prd: multi-persona-hardened-accounts
blockedBy: []
covers: [1, 6, 9]
---

## What to build

The PURE core that turns v1's single hard-coded `anon` account into N personas selected by a bare name. All pure, in `src/anon-pi.ts`, reusing/extending the v1 hardened surface.

- **Name <-> account mapping.** A pure `personaAccount(name)` that maps a user-facing bare name (`alice`) to the Unix account (`anon-alice`), and the default (empty/absent name) to the bare `anon`. Plus the inverse where needed. Validate the bare name (safe Unix-username charset, no `anon-` double-prefix, no separators that break the account), returning a clear error for an invalid name. The v1 `ANON_ACCOUNT = 'anon'` becomes the DEFAULT account (the empty-suffix case), NOT the only one.
- **`--as <name>` selection (pure parse).** A pure resolver that, given the parsed args, yields the SELECTED persona account: `--as <name>` -> `anon-<name>`, absent -> `anon` (default). A `--as` with no value, or naming an unknown persona, is surfaced as a decision the impure layer turns into an error (this task returns the resolved account + a "known?" predicate over an injected persona list; it does not do I/O).
- **Generalized loop guard.** v1's `shouldRedirectToAnon` guarded on `isAnon` (am I `anon`?). Generalize to "am I the TARGET persona account?": redirect on a hardened install when the current account != the selected persona account, and NOT when already running as it (loop guard). A persona is never auto-redirected to a DIFFERENT persona. Keep the identity + selected-account as INJECTED inputs (pure).

Reuse the existing `shouldRedirectToAnon`/`RedirectInputs` and `buildAnonSudoArgv` (which already takes the account path); thread the selected account through rather than hard-coding `anon`. Keep everything pure + injected (mirror the v1 style); the actual exec/probe/prompt is the impure layer (later tasks).

## Acceptance criteria

- [ ] `personaAccount('alice')` = `anon-alice`; the default (empty/absent) = `anon`; an invalid bare name (bad charset, already-prefixed, empty-after-trim where a name was required) yields a clear error.
- [ ] The `--as <name>` resolver yields the selected account (`anon-<name>`, default `anon`) and exposes a pure "is this persona known?" check over an INJECTED persona list; unknown/`--as`-without-value is representable as an error for the impure layer (no I/O here).
- [ ] The loop guard redirects when the current account != the selected persona account and does NOT when they match (generalized from v1's am-I-anon check); identity + selected account are injected.
- [ ] The default path is behaviour-preserving for v1: no `--as`, existing `anon` install -> redirects to `anon` exactly as before.
- [ ] Tests cover the mapping (default + named + invalid), the `--as` resolution (default/named/unknown/no-value), and the generalized guard (match vs mismatch), pure, no real sudo/whoami/fs.
- [ ] Every change produces a changeset; the `verify` gate passes.

## Blocked by

- None — can start immediately.

## Prompt

> FIRST, check this task against current reality (launch snapshot; may have drifted): confirm the v1 hardened pure surface in `src/anon-pi.ts` (`ANON_ACCOUNT`, `shouldRedirectToAnon`/`RedirectInputs`, `buildAnonSudoArgv`/`HardenedInvocation`) still has the shape this task extends, and that `docs/adr/0006` still describes the single-account model this PRD supersedes. If the surface changed, build on what landed; if a sibling multi-persona task already introduced the mapper, extend it. Route real drift to needs-attention.

You are generalizing anon-pi's v1 single-`anon`-account hardened deployment into MULTIPLE personas (prd `multi-persona-hardened-accounts`, which SUPERSEDES ADR-0006). Domain (see `CONTEXT.md`): the hardened deployment runs anon-pi under a dedicated Unix account; v1 hard-coded ONE account `anon`. Multi-persona makes it N accounts, each `anon-<name>` for a user-typed bare `<name>`, with `anon` (bare) as the default. Selection is a plain `--as <name>` flag (default `anon`); the name may appear in argv/history (accepted). This task lands the PURE core only: the name<->account mapping, the `--as` selection resolver (over an injected persona list), and the generalized self-re-exec loop guard ("am I the TARGET persona?" instead of v1's "am I anon?").

Goal: extend the v1 pure surface in `src/anon-pi.ts` so the selected persona account threads through `shouldRedirectToAnon` + `buildAnonSudoArgv` (both already take account/paths as inputs) instead of the hard-coded `anon`. Keep the default byte-behaviour-identical to v1 (no `--as`, existing `anon` install still redirects to `anon`). Everything OS-touching (whoami, the real persona list, exec) stays an INJECTED seam wired by later tasks. Do NOT change the normal non-hardened launch path, and do NOT weaken forced egress.

Test at the pure seam: mapping (default/named/invalid), `--as` resolution (default/named/unknown/no-value), generalized guard (match/mismatch). "Done" = pure surface + tests green under the verify gate, with a changeset committed.

> RECORD non-obvious in-scope decisions (e.g. the exact valid-name charset, how an unknown `--as` is represented) as an ADR if they meet the gate, else a `## Decisions` note in the done record. This task's sibling `persona-adr-and-docs` owns the superseding ADR; coordinate rather than write a second ADR.
