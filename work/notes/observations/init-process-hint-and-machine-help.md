# 2026-07-04 — init process-hint repeats per-port; `machine --help` dead branch

While building `cli-init-onboarding`:

- `anon-pi init`'s proxy findings attach the SAME weak process hint (e.g. "a
  `tor` process is running -> likely Tor") to EVERY probed port line, including
  closed ones, because the process observation is host-wide, not per-port. It is
  honest and never labels the exit provider, but reads as noise on ports the
  process is unrelated to. Consider showing the process hint once (as a general
  note) rather than per finding.
- `anon-pi machine --help` never reaches `runMachine`'s `MACHINE_HELP`: the
  global `--help` check in `main()` fires first (I narrowly excepted only `init`
  to keep `machine`'s historical behaviour). So `MACHINE_HELP` (in `cli.ts`) is
  effectively dead for the `--help` path. Not touched here (out of scope).

---

RESOLVED (2026-07-04): both fixed.
- `formatProxyFindings` now takes an optional host-wide `processNote`, shown ONCE
  as a general note; `init` passes the hint there instead of per-finding. Tests
  in `init-onboarding.test.ts` assert it appears once and closed ports carry no
  hint noise.
- The top-level `--help` intercept in `main()` now excepts BOTH `init` and
  `machine`, so `anon-pi machine --help`/`-h` reach `MACHINE_HELP`. Tests added
  in `cli-machine.test.ts`.
