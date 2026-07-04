---
'anon-pi': minor
---

Add `anon-pi init`: the honest, re-runnable onboarding that captures the
socks5h **proxy**, the local-model endpoint, and the default machine image, then
writes `config.json` + the `default` machine. It REPLACES the old `import`.

The load-bearing HONESTY constraint (this is an anonymity tool): the proxy step
presents EVIDENCE only and NEVER claims/labels the exit provider. A SOCKS proxy
does not announce Mullvad/Proton/etc, so a false label would be a dangerous lie.

Flow (`src/cli.ts`, with the DECISIONS pure in `src/anon-pi.ts`):

1. **Proxy**: probes common SOCKS ports (9050 Tor, 9150 Tor Browser, 1080
   generic wireproxy/ssh -D), CONFIRMS each really speaks SOCKS5 via a real
   method-selection handshake, and shows the findings as EVIDENCE (open + SOCKS5
   verdict + a structural port hint + a WEAK local process hint like "a `tor`
   process is running -> likely Tor") with NO provider label. You choose a
   confirmed port or enter `host:port`; it then runs
   `netcage verify --proxy socks5h://<chosen>` and shows the real EXIT IP as
   proof it is not the host IP. You confirm on that evidence.
2. **Local model endpoint**: captures `host:port`, probes reachability
   (evidence, not a gate), and generates the machine's `models.json` from it via
   the pure `generateModelsJson` (the `import` replacement: no host pi config is
   read, so no other provider / paid key / session identity can leak).
3. **Default machine image**: a menu from the shipped Dockerfiles (`Dockerfile.pi`
   / `examples/Dockerfile.pi-webveil`, built via `podman build`), an existing
   image ref, or skip (imageless; pinned later).
4. Writes `config.json` (`{ proxy, llm, defaultMachine }`) + the `default`
   machine. Re-runnable: it pre-fills current values and NEVER destroys machines
   or homes (an existing home is kept intact; an existing machine is only re-pinned
   when a new image is chosen).

New PURE exports in `src/anon-pi.ts` (all unit-tested): `DEFAULT_SOCKS_PROBE_PORTS`,
`SOCKS5_METHOD_SELECTOR`, `interpretSocks5Handshake`, `processHint`,
`formatProxyFindings` (+ `FORBIDDEN_PROVIDER_LABELS`, with a test asserting the
formatter NEVER emits a provider label), `socks5hUrl`, `parseVerifyExitIp`,
`initImageMenu`, and `serializeConfigJson`. The socket probes, the `netcage
verify` / `podman build` spawns, and the prompts are the thin impure I/O.

`anon-pi init --help` now shows init's own help (the global `--help` yields to a
subcommand that owns one). `import` is gone.
