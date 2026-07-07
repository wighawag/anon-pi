# anon-pi

## 0.29.0

### Minor Changes

- 79cfc7b: Add `anon-pi persona rm [<name>]`: print the root teardown commands for a persona.

  The mirror of `persona add`. It PRINTS the root commands to tear a persona down (remove its scoped sudoers rule, `loginctl disable-linger`, then `userdel -r anon-<name>`) for you to paste into a root shell; anon-pi never runs them (consistent with the "print Tier-2, never sudo" principle). A bare `rm` targets the default `anon`.

  `userdel -r` deletes the account's mode-700 home and ALL its anonymized session transcripts (irreversible), so it is gated: on a TTY it asks you to type the account name to confirm before printing (or pass `--yes`); without a TTY it refuses unless `--yes`. If the account does not exist it says so and the printed commands are harmless no-ops (handy to clean a leftover sudoers rule). New pure `buildPersonaTeardownScript` (ordered so the sudoers rule is removed and linger disabled before `userdel`, testable as a string) and the `rm` grammar in `parsePersonaArgs`.

## 0.28.0

### Minor Changes

- dd032c5: init: on a hardened install, build the image AS the `anon` account so it lands in that account's netcage store.

  netcage's podman store is uid-scoped (`/var/tmp/netcage-storage-<uid>`), so an image built as the login user is invisible to the `anon` account that the hardened jail runs as. Previously init's image step ran the exists-check and the build as the login user even when hardened, so the image landed in the wrong store: the hardened launch could not see it (and the exists-check always missed, forcing a needless rebuild).

  Now, on a hardened install, init crosses to the account (`sudo -u anon -i anon-pi __image-exists|__image-build ...`, the same mechanism as the launch redirect) for both the exists-check and the build, so the image is created directly in the account's own store where the jail reads it. The build streams as before. Non-hardened installs are unchanged. New internal subcommands `__image-exists`/`__image-build` and the pure `shippedImageTag`. Because each account's store is separate by design (persona isolation), a hardened persona builds its own copy; there is no shared image store.

## 0.27.0

### Minor Changes

- c2c25b1: init: ask hardening FIRST, show only the still-needed root commands, and add color + clearer section headers.

  - **Hardening is now Step 1** (was Step 4). It is the most likely step to block (it needs a system-wide anon-pi + netcage and a provisioned account), so asking + running its preflight first means you find out before investing in the proxy/model/image steps, and every later step is hardened-aware from the start.
  - **The Tier-2 root command block is filtered to only what is missing.** Previously it always printed every step (`useradd`, `loginctl enable-linger`, netcage install, sudoers) even when the check for that step already passed; a re-run whose account already existed still showed `useradd -m anon`. Now the block emits only the steps whose preflight check failed (renumbered with no gaps); the sudoers step is always emitted (idempotent, no probe). New pure `tier2NeedsFromFailures` maps failing check ids to needed steps.
  - **Clearer + colored onboarding.** Section headers are titled/ruled, the "what is still needed" failures are listed above the commands, and output is colored (bold/cyan titles, green success, yellow/red warnings), gated on the stdout TTY + `NO_COLOR` so pipes and `NO_COLOR` stay plain.

## 0.26.0

### Minor Changes

- 8e04dd9: Hardening now requires a system-wide anon-pi, and refuses a per-user (Volta/nvm) install instead of failing after the sudo prompt.

  The dedicated `anon` account runs anon-pi as itself (`sudo -u anon -i anon-pi ...`), so anon-pi must live where that account can execute it. A per-user Node manager (Volta, nvm, asdf, fnm) installs anon-pi under the login home (e.g. `~/.volta/bin/volta-shim`), which the `anon` account cannot traverse or run. Previously this produced `Permission denied` AFTER the password prompt, and worse, baked a root sudoers rule pointing at that login-user-writable path (a privilege-scoping hole).

  Now:

  - The hardened preflight (used by `init` and `persona add`) gains an `anon-pi-binary` check via the new pure `crossAccountBinaryUnsuitable` (rejects a path under the login home, a version-manager shim, a `.js` entry, or nothing). It fails loudly and early with remediation: install anon-pi system-wide (on `/usr/local/bin` or `/usr/bin` via a system Node) and remove the per-user copy. This is hardening-only: a non-hardened anon-pi via Volta/nvm is unaffected.
  - `buildTier2ProvisioningScript` refuses to emit a sudoers rule scoped to an unsuitable/login-home anon-pi path (closes the caller-writable-target hole), and now includes a system-wide netcage install (`curl -fsSL .../install.sh | PREFIX=/usr/local/bin sh`), since netcage's default `~/.local/bin` install is also unreachable cross-account.
  - On every hardened execution, the login-side anon-pi forwards its version across the crossing; the account-side child refuses on a version mismatch (a per-user vs system install divergence), so the two never silently differ.

## 0.25.2

### Patch Changes

- 37f8931: init: on a hardened (re)configure, don't keep a stored projects root that leaks the login home.

  Re-running `init` over an existing config offered the stored projects root as the Enter-default. On a hardened install, if that stored value was under the login home (e.g. `/home/<user>/anon`, carried over from a previously non-hardened install), it was still shown as the default AND pressing Enter kept it, silently re-mounting the login-home path and re-introducing the exact username leak the hardened projects step exists to prevent (the leak check only ran on a typed path, not on Enter/keep).

  Now a stored projects root that leaks under hardening is NOT kept: the prompt defaults to the `anon`-account tree, explains that the current value was dropped, and neither Enter nor Ctrl-C can retain the leaking path. New pure `resolveInitProjectsDefault` encodes the keep-vs-drop decision (unit-tested). Non-hardened installs are unchanged (a login-home projects root is fine and kept).

## 0.25.1

### Patch Changes

- 8b4738d: init: neutral wording for a non-egress `netcage verify` failure.

  The investigation into the `dns-resolves-over-tcp-glibc` FAIL found it was a false negative (the ~950 MB glibc probe image was pulled through the proxy and blew the verify budget; DNS/forwarder/firewall were all fine), and netcage now distinguishes a probe/pull failure from a real functionality failure. init's proceed-anyway prompt no longer presumes the non-egress failure is a DNS issue; it points the user at the specific failed assertion in netcage's output. No behaviour change: the egress exit-IP proof stays load-bearing and a genuine non-egress failure still offers a deliberate proceed-anyway (default no).

## 0.25.0

### Minor Changes

- 4236988: init: don't rebuild a shipped image that already exists.

  Choosing the basic/webveil image at init's image step always ran the (multi-minute) `podman`/`netcage build`, even when the exact tag was already in netcage's store. Re-running `init` (e.g. after an anon-pi upgrade, whose new versioned install path can also bust the build cache) therefore re-triggered a full rebuild.

  init now checks whether the shipped tag (`localhost/anon-pi/pi[-webveil]:latest`) is already present (`netcage images --format json`) and offers to REUSE it (default) instead of rebuilding; answer `n` to force a fresh build. New pure `imageTagPresent` does the match, tolerant of the `localhost/` prefix and an implicit `:latest`. The store probe fails toward building (never toward a stale skip), so a probe miss can't reuse a missing image.

## 0.24.0

### Minor Changes

- 13c0073: init: don't trap the proxy step on a non-anonymity `netcage verify` failure.

  `netcage verify` runs several assertions and exits non-zero if ANY fails. init keyed off that aggregate exit code, so a functionality failure (e.g. netcage 0.11.0's `dns-resolves-over-tcp-glibc`) would block proxy selection even though the forced-egress exit-IP proof (`forced-egress-exit-ip-differs-from-host`) PASSED and the proxy is genuinely anonymizing.

  init now distinguishes the two. New pure `verifyEgressAssertionPassed` (a targeted scan for the `[PASS]` egress-assertion line; the assertion id is pinned by a test) gates the behaviour:

  - egress assertion PASS but verify exited non-zero (a non-anonymity failure, most likely an in-jail DNS/functionality issue, which is netcage-side): init shows the output and offers a deliberate proceed-anyway prompt, defaulting to NO.
  - egress assertion ABSENT or FAIL (a real anonymity failure, or netcage could not prove egress): no override, re-pick the proxy as before.

  The anonymity proof stays load-bearing and is never bypassable; this only stops a functionality assertion from trapping the user. anon-pi still touches no netcage invariant.

## 0.23.1

### Patch Changes

- e838459: Fix `EACCES: permission denied, mkdir '/home/anon/.anon-pi'` when hardening via `init` (and the identical bug in `persona add`).

  On a hardened install the workspace lives in the dedicated account's mode-700 home, which the login user cannot write. `init`'s hardening step (and `persona add`) tried to `mkdir`/write that home AS THE LOGIN USER, which crashed with EACCES; and even absent the crash, the config/machine/models writes landed in the login user's `~/.anon-pi` instead of the account's, so a hardened launch (which self-re-execs as the account) would find no config.

  The workspace writes now happen AS the account, per ADR-0006 ("the login user must not write the workspace"). anon-pi crosses the same way a launch does, by spawning `sudo -u <account> -i anon-pi __init-apply` (permitted by the scoped sudoers rule), and pipes the already-resolved config on STDIN (not an argv path or a temp file), so nothing sensitive appears in `ps` and the `--force-allow-local-llm-api-key` case does not leak. The account-side child performs the writes into its own mode-700 `~/.anon-pi`. Non-hardened installs are unchanged (they write locally as before).

## 0.23.0

### Minor Changes

- 1017633: init: harden the projects-root choice against a login-username leak, and make the hardening choice explicit.

  - The hardened-deployment question now runs BEFORE the projects-root step (it was last), so the projects-root step knows whether the install is hardened.
  - On a hardened install the projects root now defaults to the `anon` account's tree, and a path under the login home is REFUSED. The projects root is the host bind-mount source for `/projects`, so a login-home path would leak the login username (through the mount source and file ownership) into the anon-run jail, defeating the dedicated account. New pure `projectsRootLeaksLogin` encodes the check (separator-aware, so a prefix-sharing sibling like `/home/user-old` is not treated as under `/home/user`).
  - The hardening question has NO default: it requires an explicit `y`/`n`, and an empty answer re-asks rather than silently declining. Ctrl-C/EOF aborts init as before.
  - The "already hardened, skip the question" check is now persona-aware (`isAnonPersonaAccount`): it recognizes running under a namespaced `anon-<name>` account, not only the bare `anon`.

## 0.22.0

### Minor Changes

- a5f7e4e: feat(persona): add the `anon-pi persona add <name>` verb (prd `multi-persona-hardened-accounts`, decisions 4-8, superseding ADR-0006). A new `persona` noun (mirroring `machine`/`image`/`container`), with the thin impure wiring around the pure sibling pieces, provisions a persona: it maps the bare `<name>` to the account `anon-<name>` (a bare `add` is the default persona `anon`) and errors clearly on an invalid name. It CHOOSES the per-persona fail-closed egress: `--tor [<host:port>]` composes `socks5h://anon-<name>:x@<host:port>` (the account name as the Tor SOCKS-isolation username), `--proxy <socks5h-url>` takes a bring-your-own endpoint and PRINTS the one-line uniqueness warning (`PERSONA_BYO_UNIQUENESS_WARNING`; no used-endpoint list is stored), and on a TTY with neither flag it probes for a running Tor (the injected `offerTor` seam) and offers it, else prompts for a BYO endpoint. It runs v1's RESUMABLE two-tier flow per persona (new pure `planPersonaAdd`): while the account is missing it PRINTS the Tier-2 copy-paste root commands (the reshaped generator) for the human to paste into a root shell they enter first (anon-pi never runs them), and once the account exists it writes the persona's OWN ordinary v1 `config.json` (carrying its `proxy`) into `~anon-<name>/.anon-pi` at mode 0700. Re-running `persona add` for a fully-provisioned persona is an idempotent no-op re-check. Persona identity (email/git) stays out of scope (set inside the persona home); anon-pi never silently sudo's and never weakens forced egress. New pure library surface: `parsePersonaArgs`, `planPersonaAdd`, `PERSONA_BYO_UNIQUENESS_WARNING`, `PERSONA_HOME_MODE`.
- c91bb38: feat(persona): wire day-to-day `--as <name>` persona selection into the hardened launch entry (prd `multi-persona-hardened-accounts`, decisions 2 + 6 + 8 + 9, superseding ADR-0006). Generalizes v1's single-account self-re-exec (`maybeRedirectToAnon`) to the SELECTED persona: on a hardened install `anon-pi --as <name> …` re-execs into `anon-<name>` (default `anon`) via `sudo -u <account> -i <anon-pi> …`, launching with THAT persona's own proxy (resolved from the persona's own in-home `config.json` once running as the account, fail-closed per persona). The impure wiring stays thin over the pure sibling pieces: `resolvePersonaSelection` (parse `--as`, default `anon`, unknown-persona error), `shouldRedirectToPersona` (the generalized "am I the TARGET persona?" loop guard), and `buildAnonSudoArgv`/`buildAnonSuFallback` (now taking an optional `account`, defaulting to `anon` so v1 callers stay byte-identical). `--as` is STRIPPED from the argv netcage sees (new pure `stripAsFlag`) yet SURVIVES into the re-exec (the redirect forwards the raw argv, the re-exec'd child strips it before composing the jail), so the loop guard and per-persona proxy both stay correct. An unknown/unprovisioned `--as <name>` errors clearly ("no persona `<name>`; create it with `anon-pi persona add <name>`") via a getent existence probe of the selected account, never a silent create and never a fall-through to `anon`; a missing/invalid `--as` value errors before any sudo. The no-`--as` default is byte-behaviour-identical to v1 (regression-guarded); `--version` stays local; forced egress is unchanged (still one socks5h forced per launch, this only picks WHICH persona's endpoint and WHICH account anon-pi runs as). New pure library surface: the optional `account` on `HardenedInvocation`, and `stripAsFlag`.
- 2891a77: feat(persona): add the PURE multi-persona core generalizing v1's single `anon` account (prd `multi-persona-hardened-accounts`, superseding ADR-0006). New library surface in `src/anon-pi.ts`: `personaAccount(name)` maps a bare name to `anon-<name>` (default/empty -> the bare `anon`, so v1 installs are unchanged), `validatePersonaName`/`personaName` (safe lowercase Unix-username suffix, no `anon-` double-prefix) and its inverse, `resolvePersonaSelection` (the `--as <name>` resolver over an INJECTED persona list, returning account + bare name + a known? predicate + a non-thrown error for missing-value/invalid/unknown), and `shouldRedirectToPersona` (the generalized self-re-exec loop guard "am I the TARGET persona?" replacing v1's am-I-`anon` check). All pure + injected (no whoami/sudo/fs); the default persona `anon` stays byte-behaviour-identical to v1. `ANON_ACCOUNT` is now documented as the DEFAULT (empty-suffix) persona account, not the only one. The impure wiring (whoami, real persona list, exec) lands in later tasks.
- 9d6e5a0: feat(hardened): reshape the Tier-2 root-provisioning generator to COPY-PASTE COMMANDS with auto-allocated subid (prd `multi-persona-hardened-accounts`, decisions 0 + 8, superseding ADR-0006's v1 shape). `buildTier2ProvisioningScript` now returns a block the human pastes into a root shell they enter FIRST (`sudo -i`/`su -`), NOT a `#!/bin/sh` script FILE: nothing is written to disk to leak the persona name, and entering one root shell keeps the persona name out of the audit log. It drops the hard-coded `/etc/subuid`+`/etc/subgid` range line (and the `SUBID_RANGE_START`/`SUBID_RANGE_COUNT` constants) and trusts `useradd -m <account>` to auto-allocate a free block, so N personas never collide. The scoped sudoers rule (`<login-user> ALL=(<account>) <anon-pi>`, password KEPT by default, opt-in `--nopasswd`, `visudo -cf`-validated before `install -m 0440`) now lands in a per-account file `/etc/sudoers.d/anon-pi-<account>` so provisioning a second persona never clobbers the first. Still PURE (never executed), still no cross-user `chown` and no `NETCAGE_GRAPHROOT`. Works for both the default `anon` and a persona `anon-<name>`. Ripple: `subidRemediation` reworded (points at the `useradd -m` auto-allocation, no range count), the `planHardeningStep` wait instruction reworded to the become-root-and-paste shape, and the `hardened-provisioning`/`hardened-preflight` tests updated to the new shape.
- 423e329: feat(persona): add the PURE per-persona egress composition (prd `multi-persona-hardened-accounts`, decisions 3 + 4 + 5, superseding ADR-0006). New library surface in `src/anon-pi.ts`: `composeTorPersonaProxy(account, hostPort?)` composes the literal `socks5h://<account>:x@<host:port>` (the persona account AS the SOCKS-isolation username, so Tor's `IsolateSOCKSAuth` gives each persona its own circuit/exit; default host:port `127.0.0.1:9050` via `DEFAULT_TOR_SOCKS_HOST_PORT`, ignored placeholder password `x` via `TOR_PLACEHOLDER_PASSWORD`), producing a plain literal stored verbatim in the persona's own `config.json` `proxy` field (no schema marker, no launch-time re-derivation); `offerTor(detection)` is the PURE predicate that offers the Tor path only on positive evidence (open + SOCKS5) over an INJECTED `TorDetection` probe result (the real probe reuses init's SOCKS / `netcage detect-proxy` seam, wired later in cli.ts). Per-persona fail-closed is v1's `resolveProxy` / `PROXY_REQUIRED_MESSAGE` now reading the persona's own config: a persona with no resolvable proxy refuses byte-identically to v1 and never falls back to another persona's proxy or to none. Netcage's forced-egress invariant is unchanged (still one socks5h forced per launch, fail-closed; this only picks WHICH one); no `NETCAGE_GRAPHROOT`. All pure + injected (no Tor/socket/netcage in the pure layer).

### Patch Changes

- 13b441a: fix(init): stop reporting the loopback proxy address as the "Exit IP". `netcage verify` prints the proxy URL (`proxy: socks5h://127.0.0.1:9050`) on its first line, so `init`'s naive first-IPv4 scrape reported `127.0.0.1` as the exit IP, a scary false alarm suggesting anonymization had failed. `parseVerifyExitIp` now skips the proxy line and reads the real jail exit IP from netcage's forced-egress assertion, and `init` now streams netcage's own verify output as the authoritative evidence (so a parse miss can never masquerade as the exit IP). No egress/behaviour change; display only.
- 700f310: docs(prd): add the multi-persona hardened-accounts PRD (proposed) + a GUI-via-virtual-screen idea note. Design-only, no runtime change. Generalizes the single `anon` account (v1) into N dedicated persona accounts, each with its own mode-700 home and fail-closed per-persona egress (Tor multi-persona via SOCKS-username isolation, or bring-your-own SOCKS), `anon` staying the default; supersedes ADR-0006's single-account framing. Selection is a typed interactive prompt (name kept out of logs) with a `--as` escape hatch; `persona add` provisions via a root-shell-first neutrally-named script. Persona identity (email/git) is out of scope (configured in-home); GUI is a linked idea note.
- bf41ba6: docs(prd): simplify the multi-persona hardened-accounts PRD. Drop the stored used-SOCKS list (decision 6) down to a one-line BYO warning; drop the typed-selection-prompt privacy machinery in favour of a plain `--as <name>` flag (default `anon`), deferring the history-hygiene variant to a new idea note; retire the generated `#!/bin/sh` script FILE in favour of printed copy-paste commands run in a root shell entered first (no on-disk file); and add the `anon-<name>` account-prefix decision (user types the bare `<name>`, default is bare `anon`). Tasking-only, no runtime change.
- 05d18d9: docs(prd): task the multi-persona hardened-accounts PRD. Design/tasking only, no runtime change. Emits six ready tasks (persona name<->account mapping + `--as` selector + generalized loop guard; reshaped Tier-2 copy-paste-commands generator with auto-allocated subid, superseding v1's script file; Tor detection + per-persona proxy composition; the `persona add <name>` verb; `--as` launch selection wiring; the superseding ADR + docs) and moves the PRD to `work/prds/tasked/`.
- 010b94e: docs(persona): add ADR-0007 (multi-persona hardened deployment) and update CONTEXT.md + README to the shipped multi-persona feature (prd `multi-persona-hardened-accounts`, superseding ADR-0006). `docs/adr/0007-multi-persona-hardened-accounts.md` records the durable decisions (N dedicated `anon-<name>` accounts with `anon` the default persona; `--as <name>` selection; per-persona fail-closed egress via Tor multi-persona SOCKS-isolation username or bring-your-own socks5h; the persona's ordinary in-home `config.json` as its egress store; copy-paste Tier-2 commands run in a root shell first with `useradd -m`-auto-allocated subid, no script file; the generalized "am I the TARGET persona?" loop guard) and marks ADR-0006 superseded (with a reciprocal superseded-by note on 0006). CONTEXT.md gains `persona` / default-persona / per-persona-egress vocabulary and extends the hardened-deployment + self-re-exec entries coherently. The README hardened section documents `persona add <name>`, `--as <name>`, and per-persona egress, updates the retired v1 Tier-2 script-file/explicit-subid-range framing to the shipped copy-paste-commands + auto-allocated-subid shape, and adds the honesty caveat that persona names are unavoidably in system files (defends the audit/history trail, not root forensics). Docs-only; no code or behaviour change.
- d9d26d4: docs(tasks): fix two review findings in the multi-persona tasks. `persona-as-launch-selection-wiring` no longer asks to reshape the preflight for range-existence/account (already true in v1's `probeHardenedPreflight`/`subidRangePresent`); it now threads the selected persona account to the call site instead. `persona-tier2-commands-generator` now owns the full ripple of removing `SUBID_RANGE_COUNT`/`SUBID_RANGE_START` (reword `subidRemediation`, update `hardened-preflight`/`hardened-orchestrator`/`hardened-provisioning` tests) so the reshape lands green in one step. Tasking-only, no runtime change.

## 0.21.0

### Minor Changes

- 210aaca: feat(hardened): wire the resumable init hardening step + self-re-exec into anon-pi (docs/adr/0006, prd `hardened-dedicated-account-deployment`). Adds the PURE orchestrator `planHardeningStep` in `src/anon-pi.ts`: over an INJECTED preflight result it decides the ONE next action of the resumable `init` step (a failing preflight -> emit the Tier-2 provisioning script + a run-it-then-continue instruction and WAIT; a passing preflight -> `continue-tier1`, pointing `ANON_PI_HOME` into the `anon` account's tree at mode `0o700`, no wrapper file, never `NETCAGE_GRAPHROOT`). Adds the THIN impure wiring in `src/cli.ts`: the TTY-gated `init` prompt "run under a dedicated `anon` account?" (no `harden` verb, no `--hardened` flag), the real preflight probes (`/etc/subuid`+`/etc/subgid`, `loginctl` linger, `stat /dev/net/tun`, the account `$XDG_RUNTIME_DIR`, `netcage --version`), the resumable print-script -> wait -> re-probe -> continue loop with the real mode-700 workspace write, and the launch-entry self-re-exec that on a hardened install SPAWNS `sudo -u anon -i <anon-pi> "$@"` (loop-guarded via `os.userInfo().username` so a caller already `anon` does not re-exec). Records the hardened state as a `hardened: true` marker in `config.json` (parsed/serialised, written only when true). Everything OS-touching is an injected/stubbed seam; tests isolate the workspace via a temp `ANON_PI_HOME` and a fake `sudo`, asserting the real `~/.anon-pi` is untouched and no real sudo/su/podman/netcage/loginctl runs. Extends ADR-0006.
- 12d2c15: feat(hardened): add the PURE hardened-deployment preflight predicates for the dedicated `anon` account. New `evaluateHardenedPreflight` composes five checks over INJECTED probe results (subuid/subgid ranges present, linger on, `/dev/net/tun` accessible, account `$XDG_RUNTIME_DIR` present, netcage `>= 0.11.0`) into an all-pass-or-ordered-list-of-failures result, each failing check carrying its EXACT remediation string so a half-provisioned account fails LOUDLY. The netcage floor is the single named constant `NETCAGE_MIN_VERSION = '0.11.0'` (the uid-scoped store, netcage ADR-0017), with `parseNetcageVersion` / `compareVersionTriples` / `netcageVersionSatisfies` treating an ABSENT netcage and an UNPARSEABLE version as fail-loud (never a silent pass), and distinct absent-vs-too-old remediations. Everything OS-touching (reading `/etc/subuid`, `loginctl`, `stat /dev/net/tun`, `netcage --version`) is an injected seam wired later by the init-provisioning task; nothing here spawns or touches the fs. The preflight sets no `NETCAGE_GRAPHROOT` (the uid-scoped default handles the store). Extends ADR-0006.
- 166c2db: feat(hardened): add the PURE self-re-exec invocation core for the dedicated `anon` account deployment. New pure `shouldRedirectToAnon` predicate (always-redirect on a hardened install, loop-guarded so a caller already running as `anon` does not re-exec) plus `buildAnonSudoArgv` (the login `sudo -u anon -i <anon-pi> …` form) and `buildAnonSuFallback` (the `su - anon -c '…'` fallback string). The "am I anon?" identity and the anon-pi binary path are INJECTED seams; anon-pi only ever emits a `sudo`/`su` argv (no uid change, no setuid, no spawn here — cli.ts wires the exec in a later task). Records the durable decisions in ADR-0006 and pins the `anon` account / hardened-deployment / self-re-exec vocabulary in `CONTEXT.md`. No change to the normal (non-hardened) launch path.
- db2ed2d: feat(hardened): add the PURE Tier-2 root-provisioning-script generator for the dedicated `anon` account deployment. New pure `buildTier2ProvisioningScript` emits the reviewable `#!/bin/sh` script text a human runs with sudo: `useradd -m anon`, the `/etc/subuid` + `/etc/subgid` range lines (idempotent grep-guard, pinned `SUBID_RANGE_START`/`SUBID_RANGE_COUNT`), `loginctl enable-linger anon`, and the scoped sudoers snippet `<login-user> ALL=(anon) <anon-pi>` (password KEPT by default; opt-in `--nopasswd` OFF by default, validated with `visudo -cf` and installed mode-0440). The account name, login user, and anon-pi binary path are INJECTED, so the whole script is unit-testable as a string; anon-pi PRINTS it and NEVER executes it (no spawn, no sudo, no fs here). It deliberately emits NO cross-user `chown`/workspace-migration line (deferred to the `harden` verb) and NO `NETCAGE_GRAPHROOT` export (netcage's uid-scoped store, ADR-0017, handles itself). Extends ADR-0006.

### Patch Changes

- 7a8fdd1: docs(prd): add the hardened dedicated-account deployment PRD (proposed). Design-only artifact under `work/prds/proposed/`; no runtime change. Captures running anon-pi under a single dedicated `anon` Unix account, invoked from the login user via `sudo -u anon -i`, with a two-tier "actively help, never silent root" provisioning flow (Tier 1 rootless setup + preflight; Tier 2 generated root script). One open question (the existing-workspace migrate default) still blocks tasking.
- 4102460: docs(prd): task the hardened dedicated-account deployment PRD. Design-only, no runtime change. Narrows v1 to init-driven hardening (no separate `harden` verb, no `--hardened` flag), replaces the `anon` wrapper with self-re-exec (always-redirect on a hardened install), and clears the open question by deferring the standalone `harden` verb + workspace migration to a new idea note. Emits five ready tasks (self-re-exec invocation, preflight, Tier-2 script generator, init provisioning step, docs) and moves the PRD to `work/prds/tasked/`.
- 427cbce: docs(hardened): document the hardened deployment (prd `hardened-dedicated-account-deployment`, docs/adr/0006). Adds a README section covering the init-driven flow as it actually shipped: `init`'s Step 5/5 asks "run under the dedicated `anon` account?"; Tier 1 (rootless: `ANON_PI_HOME` into the account's tree, mode 0700) is done for you, Tier 2 (root: create the account, `/etc/subuid`+`/etc/subgid` ranges, `loginctl enable-linger`, the scoped sudoers rule) is PRINTED as a reviewable script the human runs with sudo (anon-pi never sudo's for you), and `init` is RESUMABLE across it (run the script, press Enter to re-check via the preflight, continue once the account exists). Documents day-to-day self-re-exec (`sudo -u anon -i anon-pi "$@"`, one prompt within sudo's cache window; `su - anon -c '…'` fallback). States the DISCOVERABILITY-boundary caveat LOUDLY (unprivileged host agent only; root or blanket passwordless sudo defeats it, DAC is not hard containment) and the sudo-password-as-deliberate-crossing rationale. Notes it composes with the ephemeral-run idea (belt-and-suspenders) and that a standalone `harden` verb + workspace migration are a future follow-up (`harden-command-with-import` idea), not in v1. Does NOT claim hard containment and does NOT reference a `--hardened` flag or a separate `anon` wrapper command (neither exists). Docs-only; the hardened vocabulary already lives in `CONTEXT.md` (owned by `hardened-self-reexec-invocation`).
- cd7b21e: docs(tasks): resolve the hardened-preflight netcage version-floor question. Confirmed the uid-scoped store (netcage ADR-0017) shipped in netcage `v0.11.0` (commit `965c991` is the tip tagged `v0.11.0`; `v0.10.0` still carries the old fixed store), so `>= 0.11.0` is verified. Clear `needsAnswers` on `hardened-preflight-checks` and pin the floor to `0.11.0` (kept as a named constant). Tasking-only, no runtime change.
- 004356a: docs(tasks): fold review findings into the hardened-dedicated-account tasks. Flag `hardened-preflight-checks` with `needsAnswers` because the netcage version floor (`>= 0.11.0`) was unverified against a shipped netcage release; make the floor a to-confirm named constant. Give `hardened-self-reexec-invocation` explicit ownership of the hardened-dedicated-account ADR and the `CONTEXT.md` glossary entries so the vocabulary cannot re-fork. Tasking-only, no runtime change.

## 0.20.0

### Minor Changes

- 9b18d3b: Add `--mode text-stream`: watch a headless one-shot's progress live

  A plain `-p` run prints only pi's final answer, so a long run looks frozen
  while the agent works. The new anon-pi-owned mode value streams it:

  anon-pi <project> -p --mode text-stream "..."

  anon-pi strips the `text-stream` token, runs pi with `--mode json` inside the
  jail, parses that JSONL event stream on the host, and renders a readable
  per-turn view (each assistant message, plus a `> <tool>` line per tool call) to
  stderr, while pi's final answer still goes to stdout so the run stays pipeable.

  `text-stream` is anon-pi-owned: it requires `-p` and cannot be combined with
  another `--mode` (anon-pi owns the mode to drive the stream). Any other `--mode`
  value is still forwarded to pi verbatim. Interactive launches are unaffected.

## 0.19.0

### Minor Changes

- 85b977f: Forward a leading pi flag straight to pi when there is no project, so the
  explicit `pi` token is no longer required for the common case. Any flag anon-pi
  does not itself own, seen in the no-project position, is now handed to pi
  verbatim (that flag plus everything after it):

  - `anon-pi -p "hello world"` == `anon-pi pi -p "hello world"`
  - `anon-pi --model qwen3-coder` == `anon-pi pi --model qwen3-coder`

  anon-pi still captures its OWN flags first (`-m`/`--machine`, `--shell`,
  `--mount`, `-i`/`--image`) and the subcommand nouns (`machine`, `image`,
  `container`, `init`, `forward`, `ports`), so those keep working and compose
  (`anon-pi -m webveil -p "hi"`). The retired `--keep`/`--rm` and the
  needs-a-project `--fork`/`--continue` keep their existing helpful errors. The
  explicit `anon-pi pi <args…>` passthrough still works as an equivalent, clearer
  spelling.

  BREAKING: an unrecognised leading flag no longer errors with "unknown option";
  it is forwarded to pi, which rejects a genuinely bogus flag itself.

## 0.18.0

### Minor Changes

- a29206e: Add `anon-pi image snapshot <name> --update-machine <m>`: the mirror of
  `--create-machine`, it commits the running container into `anon-pi/<name>:latest`
  and RE-PINS an EXISTING machine `<m>` to the fresh snapshot in one step
  (equivalent to `image snapshot` followed by `machine set-image`). The home is
  left untouched; when `<m>` is the snapshot's own source machine the home already
  matches the new image, so the `set-image` compatibility warning is suppressed
  (re-pinning a different machine still warns).

  `--create-machine` and `--update-machine` are mutually exclusive and each
  fail-fast on the wrong existence state (`--create-machine` refuses an existing
  name; `--update-machine` a missing one), so a mistyped name never silently
  mutates a durable machine.

## 0.17.0

### Minor Changes

- fd010f5: Implement the `container create` and `container enter` verb bodies (the durable
  named box lifecycle from the container ADR / `container-noun-parse-and-plan`
  foundation).

  - `anon-pi container create <name> [-i <ref>] [-m <machine>] [--mount <p>]
[<project>|--shell]` now instantiates a DURABLE jailed box: a `netcage run`
    WITHOUT `--rm` (so it survives exit), `--name`d and stamped with the
    `anon-pi.container=<name>` label. The image is FROZEN via the normal launch
    chain (`-i` > machine.json image > `ANON_PI_IMAGE`) and the cwd is FROZEN from
    the create-time mode word. `-m` picks the HOME and `--mount` composes exactly as
    a normal launch. Forced egress (the proxy + the one `--allow-direct`) and the
    two invariant mounts are intact: a durable box is still fully jailed. Creating a
    box whose name ALREADY exists FAILS FAST with a clear error (never a silent
    re-enter or clobber).
  - `anon-pi container enter <name>` now re-enters a STOPPED box via `netcage start
-it <ref>`, which re-stands the jail at the box's frozen cwd and re-supplies the
    forced egress (`start` stands the jail back up). An UNKNOWN name errors (never a
    silent success), and an already-RUNNING box is REFUSED with guidance (reach its
    in-jail servers via `forward` / `ports`, or `container rm` to reset it) rather
    than opening a second attach against the same filesystem.

  Boxes are read back off the `anon-pi.container` netcage label (a new pure
  `parseContainerBoxesJson` over `netcage ps -a --format json`), so there is no
  anon-pi-side registry file: the label IS the record. `container list` / `rm` land
  in a follow-up task.

- 99a3255: Implement the `container list` and `container rm` verb bodies, completing the
  four verbs of the `container` noun (the durable-box housekeeping from the
  container ADR / `container-noun` prd).

  - `anon-pi container list` prints your durable boxes, one tab-separated row each,
    with enough identity to tell them apart: the box NAME, its MACHINE and
    CWD/PROJECT (decoded off the `anon-pi.key` identity label the launch stamps),
    its IMAGE (read back per box via `netcage inspect`), and running-or-stopped. It
    is read-only and filtered to anon-pi durable boxes only (the
    `anon-pi.container` label): a throwaway launch and a netcage sidecar are
    dropped. There is NO anon-pi-side registry file: the netcage container + its
    labels ARE the record, mirroring how `image list` reads provenance off image
    labels.
  - `anon-pi container rm <name>` removes a durable box. A STOPPED box is removed
    directly (`netcage rm <ref>`). A RUNNING box is a live instance, so it is
    GUARDED: WITHOUT `--yes` it REFUSES with "it is running, re-run with --yes"
    guidance; WITH `--yes` it STOP-then-removes in one atomic call (`netcage rm -f
<ref>`), so the user never sees a half-removed box. An UNKNOWN name errors
    (never a silent success).

  `ContainerBox` (the pure `parseContainerBoxesJson` reader) now also carries the
  raw `anon-pi.key` label so `list` can show the machine + cwd off the label with
  no extra query.

- 355f650: Add the pure foundation of a new `container` noun: explicit durable named boxes
  (`create` / `enter` / `list` / `rm`) that SURVIVE exit, reintroducing the mutable
  single-box continuity ADR-0004 dropped, but as an explicit, opt-in, NAMED noun
  with no create-vs-enter inference.

  This lands the PURE parts + the wiring; the impure verb bodies follow:

  - `parseContainerArgs` parses the four verbs into a typed `ContainerCommand`.
    `create <name> [-i <ref>] [-m <machine>] [--mount <p>] [<project>|--shell]`
    freezes the box's image + cwd at create (so it takes the cwd mode word);
    `enter <name>` takes ONLY the name and grammatically REFUSES `-i` and a
    project/`--shell` (both frozen at create), pointing at re-create / `image
snapshot`.
  - `container` is now a RESERVED noun word (alongside `machine` / `image`): a
    project can no longer be named `container`.
  - The run-plan composition (`resolveRunPlan`) is parameterised on a `durable`
    shape: a durable plan OMITS `--rm`, `--name`s the container, and stamps an
    `anon-pi.container=<name>` label, while keeping the two invariant mounts and the
    forced-egress proxy + single `--allow-direct` EXACTLY as a throwaway launch. The
    `anon-pi.key` identity label is unchanged, so `forward` / `ports` resolve a
    RUNNING durable box just as they do a throwaway one.
  - `anon-pi container --help` and the `container` dispatch are live end-to-end; the
    create/enter/list/rm bodies are stubbed here (they land in follow-up tasks).

  This DELIBERATELY re-opens ADR-0004's "throwaway always" drop, but only for the
  opt-in `container` path (the bare launch stays throwaway). Recorded in
  `docs/adr/0005-container-noun-durable-boxes.md`, which SUPERSEDES ADR-0004's
  "lost capability" note. A durable box is still FULLY jailed; the jail is never
  weakened.

## 0.16.0

### Minor Changes

- e7297cc: Introduce the top-level `image` noun and move snapshot onto it, with provenance
  baked into the image as podman labels (ADR-0003 §1+2).

  BREAKING: `machine snapshot` is renamed to `image snapshot` (a days-old verb).
  `anon-pi image snapshot <name> [-m <machine>] [--create-machine <m>]` commits the
  running container into the clean tag `anon-pi/<name>:latest` (a same-name
  re-snapshot overwrites `:latest`; the previous image becomes dangling but keeps
  its provenance). Provenance is baked via `netcage commit -c 'LABEL …'`:
  `anon-pi.source-machine` (the committed container's machine), `anon-pi.source-image`
  (read from the running container via inspect, so it is accurate even when `-i`
  made the container's image diverge from the machine's pin; falls back to
  `machine.json.image`, else the label is omitted), and `anon-pi.snapshot-at`.
  Provenance is best-effort history, never a live pointer.

  New `anon-pi image list`: read-only, zero stored state. Reads the provenance
  labels straight off the images, surfacing every `anon-pi/*` image plus any
  dangling image still carrying an `anon-pi.source-machine` label (an orphaned
  snapshot whose `:latest` tag was overwritten), by its ID.

  `machine create <name> --image <ref>` is now provenance-aware: if `<ref>` was
  produced by `image snapshot` and its source machine's home still exists, the
  home-copy (minus sessions) + per-project session carry-over are offered (the
  same prompts the 0.15 snapshot ran). `image snapshot --create-machine <m>` is
  the one-step convenience for the common path. Both share one
  `carryOverHomeFromMachine` helper; both honor the no-TTY "copy nothing" rule.

  Also: the subcommand noun words (`machine`, `image`, `init`, `forward`, `ports`)
  are now reserved names, so a project/machine/image can no longer be named after a
  dispatched verb (closing a latent "unreachable folder" trap). A pre-existing
  project folder now reserved is silently skipped from the menu (never a crash),
  and creating such a name is refused with a clear "reserved name" error.

- f7142ac: Add the ephemeral per-launch image override `-i <ref>` / `--image <ref>` to the
  launch grammar (beside `-m`, `--shell`, `--mount`) (ADR-0003 §3).

  `-i` is the highest-priority image source: `-i` > `machine.json.image` >
  `ANON_PI_IMAGE` > error. It composes with `-m` (`-m` picks the HOME, `-i` picks
  the IMAGE) and is STRICTLY EPHEMERAL: it NEVER mutates `machine.json` (to re-pin
  a machine's image use `machine set-image` / `machine create --image`) and prints
  NO mismatch warning (`-i` is explicit + ephemeral, so a warning carries no
  information the user lacks).

  On a FRESH (unseeded) machine home `-i` is REFUSED with guidance: seeding the
  home from the ephemeral image would poison it with the wrong-image seed, so
  anon-pi points at `anon-pi machine create <m> --image <ref>` (or a normal launch
  to seed) instead. On an already-seeded home `-i` just runs the override image
  against the existing home (the runtime extension-compat risk is accepted
  silently, per ADR-0003).

  `-i` resolves in NETCAGE'S private image store (where `anon-pi/<name>:latest`
  snapshots and `init`-built images live), NOT the operator's default podman
  store. anon-pi does NOT pre-check the ref and does NOT auto-pull (an anonymity
  tool must not silently fetch a remote image); netcage/podman surfaces its own
  "not found" via inherited stdio. The `--help` text documents this store boundary
  so a "not found" is understood (fix: `image snapshot` it, or build it into
  netcage's store).

- 0b31321: Retire `--keep`/`--rm`: every launch is now throwaway (the container is always
  `--rm`).

  BREAKING: the `--keep` and `--rm` launch flags are removed. Passing either now
  errors with guidance toward image-based persistence: snapshot the running
  container into a named image (`anon-pi image snapshot <name>`) and pin a
  machine to it (`anon-pi machine create <m> --image anon-pi/<name>:latest`). The exploratory
  "apt install, quit, re-enter" pet-container flow (and the kept-container
  run-vs-start inference behind it) is gone; durable state is explicit and named
  instead of an inferred mutable container. Your pi config and conversations live
  in the machine home (a host mount) and persist regardless.

  `forward`, `ports`, and `image snapshot` are unchanged: anon-pi still stamps
  its `anon-pi.key` identity label on every launch and reads it back to resolve a
  running container by machine + project (the label survives; only the
  kept-container matching was removed).

  Per the ADR-0004 rollout, this ships as part of the combined 0.16.0 release
  alongside the `image` noun and the `-i` launch override.

## 0.15.0

### Minor Changes

- 1de59d6: `machine snapshot` now carries the source machine's HOME into the new machine
  instead of leaving it fresh. The home is copied entirely EXCEPT its conversations
  (config, extensions, downloaded tool binaries, dotfiles, the seed marker), which
  is safe and preferable here because the new image IS the committed source
  filesystem, so the copied extensions/binaries are correct for it (and the new
  home is not re-seeded).

  Conversations are handled deliberately: on a TTY you are offered each one grouped
  BY PROJECT, opt-in per project (default SKIP), choosing COPY or SKIP for each
  (with no TTY, none are copied, so scripted snapshots stay clean). COPY never
  touches the source machine; after copying, a single confirmed step (default No)
  can DELETE the copied groups from the source machine (the only way to "move" a
  conversation out). This keeps the per-machine-history isolation intact: a
  snapshot does not silently inherit the source machine's whole history.

## 0.14.0

### Minor Changes

- 1f3f166: `machine snapshot` is now container-first: `anon-pi machine snapshot <new-name>
[-m <machine>] [--image-tag <ref>]`. The sole positional is the NEW machine
  name; the running container to commit is auto-detected from the running anon-pi
  containers (a picker when several are up), and `-m <machine>` is an OPTIONAL
  narrowing filter, NOT a required source. This drops the awkward mandatory
  source-machine positional from the initial 0.13.0 shape: what matters is the
  container to snapshot, and the machine is only a filter, exactly as it is for
  `forward`/`ports`.

## 0.13.0

### Minor Changes

- 829f02e: Add `anon-pi machine snapshot <machine> <new-name> [--image-tag <ref>]`: commit
  the current filesystem of a machine's RUNNING jailed container into a new image
  and create a new machine pinned to it. This lets you preserve an environment you
  built interactively (e.g. after `sudo apt install`) WITHOUT having pre-decided
  `--keep`, as long as the session is still running (the default `--rm` deletes
  the container on exit). podman pauses the container briefly during the commit,
  so the live session survives; the new machine gets a fresh home (the image is
  the software, the home is a separate host mount) and relaunches through the same
  forced-egress jail.

## 0.12.0

### Minor Changes

- 44a07f4: `--shell` with no project now lands at the projects root (`/projects`, or
  `/work` under `--mount`) instead of the machine home (`/root`). The model is
  project-centric and the shell is the project-hopper, so the projects root is the
  natural landing; anything written under the machine home persists into that
  machine's config home on the host, which is for config, not work. `--shell .` is
  now an exact synonym for a bare `--shell`, and the machine home is still one
  `cd ~` away inside the jail.

## 0.11.1

### Patch Changes

- c9822ad: Fix `forward`/`ports` (and `--keep` run-vs-start) container resolution: read
  netcage's managed containers via `netcage ps --format json`.

  The container lookup parsed `netcage ps` with a `{{.ID}}\t{{.Labels}}` Go
  template, but netcage < 0.10.0 ignored `--format` and printed a fixed human
  table with no Labels column, so anon-pi never found a running container:
  `anon-pi forward` always reported "no running anon-pi container" (and `--keep`
  always fell back to a fresh run instead of resuming). netcage 0.10.0 makes
  `ps`/`inspect` forward podman's read-only output flags, so anon-pi now queries
  `netcage ps --format json` and parses the structured `Labels` object (a robust
  `parseNetcagePsJson`), decoding the `anon-pi.key` label to match the container.
  `forward`/`ports` therefore require **netcage >= 0.10.0**.

  Also: the "entering the netcage jail" status line no longer prints for
  `forward` (it attaches to an existing jail, and prints its own "forwarding to …"
  line); it stays on the launch paths (`run`/`start`) where the jail is set up.

## 0.11.0

### Minor Changes

- 1a47ca3: Add `anon-pi forward` and `anon-pi ports`: reach an in-jail server from the host
  (wraps netcage >= 0.9.0's host-access verbs).

  - **`anon-pi forward [<project>] [--port <[hostPort:]jailPort>] [--bind <addr>]
[-m <machine>]`** opens a host port onto a running container's in-jail server
    (a dev/preview server, a local API), the way `kubectl port-forward` / `ssh -L`
    work. It resolves the running anon-pi container(s) for you (no raw netcage
    container name), and shells out to `netcage forward`. The port is host-first
    like docker/kubectl, so `--port 8080:3001` binds host 8080 onto jail 3001;
    `--bind 0.0.0.0` (passed through to netcage) exposes it on the LAN. The bare
    positional is ALWAYS the project (a numeric name like `3001` is a project,
    never a port), and it only filters the candidates. If several containers match
    you pick one from a list annotated with each one's open in-jail ports. Omit
    `--port` to be shown the container's listeners and prompted for the jail port
    and an optional different host port; an explicit `--port` may name a port that
    is not open yet (the forward binds the host side immediately).
  - **`anon-pi ports [<project>] [-m <machine>]`** lists a running container's open
    in-jail TCP listeners via `netcage ports --json`, image-independently (netcage
    reads `/proc/net/tcp*` via the sidecar, so it works even with no
    `ss`/`netstat`/`nc` in the image). Use it to find which port to forward.
  - **Every launch now stamps the anon-pi identity label** (previously only
    `--keep` did), so `forward`/`ports` can find the running container even for a
    throwaway `--rm` launch. The label is additive and egress-neutral; `--rm`
    still removes the container on exit.

## 0.10.0

### Minor Changes

- a4114a9: Resume a session in its own project, and make `--fork`/`--continue` require a
  project.

  - **`anon-pi --session <id>` (and `--session-id`/`--resume`/`-r`) now resume in
    place.** anon-pi looks the session id up in the machine's session store, reads
    the project cwd it belongs to (from the session file's header record), and
    launches pi with `-w <that cwd>`. So pi reopens the conversation directly
    instead of prompting `Session found in different project: … Fork? [y/N]`
    (which happened because anon-pi previously launched pi at the projects root,
    a cwd that never matched the session). An unresolvable id falls back to the
    old behaviour (launch at the projects root, let pi decide), so it is pure
    upside. An explicitly named project still wins (the user is trusted; pi's own
    fork-prompt guards a genuine cwd mismatch).
  - **`--fork` and `--continue`/`-c` now require a project.** With no project they
    would land a new (`--fork`) or newest (`--continue`) conversation in the
    projects root by surprise. anon-pi now refuses them without a project and
    points you at a copy-pasteable fix: `anon-pi <project> --fork <id>` (the
    project may be `.` for the root, and is created on demand, so
    `anon-pi newproj --fork <id>` forks into a fresh `/projects/newproj`).

## 0.9.1

### Patch Changes

- 6c55142: Print a status line before entering the jail, and refresh the build-verb docs
  for netcage 0.7.1.

  - **Explain the launch pause.** Every launch now prints
    `anon-pi: entering the netcage jail (setting up forced-egress)…` (to stderr)
    right before spawning netcage. netcage sets up the jail (netns, firewall, DNS,
    container start) before pi paints, so without this the user saw only a blinking
    cursor during the gap. The message is transient (pi clears the screen when its
    TUI comes up) and covers the menu, direct, and shell launch paths through the
    single `spawnNetcage` chokepoint.
  - **Docs honesty for netcage 0.7.1.** The `netcage build`/`load` verbs shipped in
    netcage 0.7.1, so the README and `buildImage`/`loadImageIntoNetcageStore`
    comments no longer frame them as a "future"/"interim" workaround. The preferred
    native `netcage build` path is unchanged.

## 0.9.0

### Minor Changes

- f0a8de9: Fix launches against netcage v0.7.0's private image store, expand `~` in paths,
  reuse netcage's proxy scanner, and fully-qualify built image tags.

  - **Build images into netcage's store.** Since netcage v0.7.0 every `netcage run`
    uses a private podman graphroot (`/var/tmp/netcage-storage`), not your default
    rootless store, so a plain `podman build` image was invisible to launches
    (podman tried to pull the `localhost/…` ref and failed — which looked like a
    hang). `init` now prefers `netcage build` when available, and otherwise builds
    with podman and loads the image into netcage's store. `resolveNetcageGraphroot`
    honours `NETCAGE_GRAPHROOT`.
  - **Fully-qualified image tags.** `init` now tags built images
    `localhost/anon-pi/pi[-webveil]:latest` (podman refuses an unqualified short
    name at run time).
  - **Expand `~` in host paths.** The `init` projects-root step and `--mount` now
    expand a leading `~`/`~/` to `$HOME` (`path.resolve` alone left a literal `~`
    dir), and config/env projects-root values are expanded too.
  - **Reuse netcage's SOCKS scanner.** `init`'s proxy step uses `netcage
detect-proxy --json` (its probe + SOCKS5 handshake + process hint) when
    available, falling back to anon-pi's own local probe; findings render through
    the same honest formatter (never labels the provider).
  - **README** is now the repo-root `README.md` (source of truth), copied into the
    package at build/pack time.

## 0.8.0

### Minor Changes

- e2115e6: Forward pi's session-resume flags, so `anon-pi --session <id>` works.

  pi prints `To resume this session: pi --session <id>` on exit. That command is
  now usable by just prefixing `anon-pi`:

  - `anon-pi --session <id>` / `--session-id <id>` / `--resume` (`-r`) /
    `--continue` (`-c`) / `--fork <id>` launch pi with NO anon-pi project and
    forward the flag(s) verbatim. pi resolves the session by id (session files live
    in the always-mounted machine home) and switches to its own project cwd, so no
    project is needed. `-m <machine>` before the flag still picks the machine.
  - Fixed the no-TTY discipline: a forwarded run is treated as HEADLESS (no TTY
    required) ONLY when it forwards pi's `-p`/`--print`. Other forwarded flags
    (e.g. `--session`, `--model`) stay INTERACTIVE and keep the TTY + `-it`
    (previously any forwarded arg was wrongly treated as headless).
  - `--shell` + a session flag is a clear error (a shell has no session to resume).

- 206a980: Add `--version`, `--list-models`, and the `anon-pi pi <args…>` passthrough.

  - **`anon-pi --version` / `-V`** prints anon-pi's own version (it previously
    errored). For pi's version inside the jail, use `anon-pi pi --version`.
  - **`anon-pi --list-models` / `--models`** lists the models pi sees, with no
    project needed (a pi query that prints and exits).
  - **`anon-pi pi <args…>`** is a general passthrough: run pi inside the jail with
    ANY args and no project (`anon-pi pi --model x`, `anon-pi pi --export out.html
--session <id>`), so anon-pi never has to special-case each pi flag. `pi` is
    reserved as a project name so the token cannot be shadowed.

  These slot into the same no-project pi-launch mechanism as `--session` (cwd at
  the projects root, interactive unless `-p`/`--print` is forwarded, forced-egress
  jail intact). Combined pi flags already work everywhere:
  `anon-pi --session <id> --model qwen`, `anon-pi recon --model x --thinking high`.

## 0.7.0

### Minor Changes

- 53e0af7: The local-model seed is now GLOBAL (shared by every machine), not per-`default`.

  Because `config.json` holds one `llm` endpoint (the single `--allow-direct` hole,
  shared across machines), the generated `models.json` describing it should be
  shared too — previously it lived under `machines/default/` and only that machine
  got it, so a second machine launched with an empty models list.

  - `init` now writes a **global** `~/.anon-pi/models.json` + `settings-seed.json`,
    and updates every ALREADY-seeded machine home in place (conversations
    untouched) so a re-run actually takes effect.
  - Every machine's fresh-home seed resolves the global seed by default, with an
    optional per-machine override (`machines/<M>/models.json`) for the rare case
    where a machine points at a different local model.
  - Migration: `init` removes the old `machines/default/models.json` +
    `settings-seed.json` it wrote in prior versions, so `default` picks up the
    global seed like every other machine.

  This also fixes: re-running `init` now updates an existing home (prior versions
  wrote the seed but the marker-guarded first-launch promotion never re-applied it
  to an already-seeded home).

## 0.6.0

### Minor Changes

- 33c5b3f: First-run onboarding + a projects-root step in `init`.

  - **Auto-onboard on first launch.** Running a launch (e.g. `anon-pi` or
    `anon-pi <project>`) with no `config.json` yet now shows a short welcome and
    runs `anon-pi init` automatically, then continues into the launch — instead of
    failing deep with the bare "set `ANON_PI_PROXY`" guidance the first time. It
    only auto-onboards on an interactive terminal; a script (no TTY) still gets the
    fail-closed proxy error, and an env-driven run (`ANON_PI_PROXY` set) skips
    onboarding entirely.
  - **`init` gained a projects-root step (now 4 steps).** After the image step,
    `init` asks for the projects root — the host folder mounted at `/projects`
    where bare `anon-pi` looks for projects — defaulting to `~/.anon-pi/projects/`.
    Point it at your own dev folder to jail pi into files you edit with host tools;
    `--mount <parent>` still overrides it per-launch. Accepting the default leaves
    `config.json` clean (no explicit `projects` key).

- 2722779: `init` now imports real models for the local endpoint (and sets a default).

  Previously the generated `models.json` had an empty models list, so pi saw the
  provider but had no pickable model. The local-model step now:

  - **Merges two endpoint-scoped sources**: the provider in your own
    `~/.pi/agent/models.json` whose baseUrl matches the endpoint (marked
    `[configured]` — your hand-tuned entries, with their `contextWindow`/
    `maxTokens`/etc. preserved) and the endpoint's live `GET /v1/models` (marked
    `[server]`). ONLY the provider served by the endpoint (the one
    `--allow-direct` hole) is ever read, so no other provider — and no other key —
    can enter the seed.
  - **Lets you choose** which models to import (Enter/`c` = all configured, `a` =
    all server+configured, numbers, `s` = skip) and **which is the default**.
  - Writes `models.json` (the chosen entries under the neutral `local` provider)
    **and** a settings seed that the first-launch promotion merges into the home's
    `settings.json` — setting `defaultProvider`/`defaultModel`/`enabledModels`
    without clobbering image-staged packages/extensions.
  - **Refuses a real apiKey by default**: if the matching host provider carries a
    non-benign apiKey, init aborts (a host credential should not enter the anon
    home) unless you pass `--force-allow-local-llm-api-key`, which carries it
    through with a warning.

## 0.5.0

### Minor Changes

- e513a8f: Land the bare-launch **interactive menu**: bare `anon-pi` (and bare `-m
<machine>` / `--mount <parent>` with no project) now shows a host-side arrow-key
  menu BEFORE any jail runs, and launches the chosen thing on Enter.

  The menu is a PURE host-side read (no jail runs until you pick): it lists the
  active root's projects (`readdir`) plus each machine's pi session dirs
  (`readdir`) and feeds them to the pure `buildMenuChoiceList` /
  `deriveProjectUsage` / `buildMenuEntries`. Each project row is ANNOTATED with the
  machines it has been used on and flags whether the current machine is new for it
  (`used on: <machines>; new here`), derived from session-dir presence, no marker
  file. Conversations are per-machine, project files are global.

  Selection dispatches to the SAME launch paths as the equivalent typed command
  (re-resolved through `resolveRunPlan` + a shared `executeLaunchPlan`, so a menu
  pick launches byte-for-byte identically): a project or the `.` "here" entry -> pi
  (`/projects/<name>` or the root itself); `+ new project…` -> prompt + validate a
  name (`validateName`) then pi; `shell` -> the `--shell` jailed bash.

  The selector is a HAND-ROLLED, zero-dependency raw-mode `select()` (a small
  supply-chain surface is on-brand for a security tool; the list is short):
  up/down (arrows or `k`/`j`) move a `>` cursor over a highlighted row, Enter
  selects, Ctrl-C / `q` / Esc cancels, and the terminal is ALWAYS restored (raw
  mode off, cursor shown) on every exit path. It is isolated behind a tiny
  signature so a prompt lib could swap in later as a localized change. No-TTY reuses
  the bare-launch error (the menu never runs without a terminal).

  New PURE, unit-tested exports in `src/anon-pi.ts`: `MenuEntry` /
  `MenuEntryKind`, `buildMenuEntries`, `formatProjectAnnotation`, and the fixed
  labels `MENU_HERE_LABEL` / `MENU_NEW_LABEL` / `MENU_SHELL_LABEL`. ALL the menu's
  logic (entry order + annotation wording) lives in the pure module; the raw-mode
  render/select is the only untested I/O.

- e0ccad1: Add the destructive cleanup verbs `anon-pi --delete-home [<machine>]` and
  `anon-pi --delete-project <project>` to `src/cli.ts`, replacing the old
  `--fresh`. The pure module (`src/anon-pi.ts`) resolves the affected host paths;
  the CLI does only the I/O (read config, filter to existing paths, run the
  confirm/`--yes`/non-TTY discipline, then `rm`).

  - **`--delete-home [<machine>]`**: deletes ONE machine's HOME (config + convos +
    shell env), keeping its `machine.json` image pin (so it can be relaunched to
    seed a FRESH home) and ALL project files (they live under the projects root).
    The default machine (`config.defaultMachine`, else the built-in
    `DEFAULT_MACHINE`) is used when the name is omitted.
  - **`--delete-project <project>`**: deletes the project's FILES (its folder under
    the resolved projects root) AND that project's per-machine session dir in EVERY
    machine home (the machine-invariant `/projects/<name>` slug), keeping the homes
    otherwise intact. The project name is REQUIRED.

  Both confirm `[y/N]` on a TTY, take `--yes` / `-y` to skip, and ABORT on a
  non-TTY without `--yes` (never delete unprompted in a script), matching the
  existing `machine rm` discipline. Both honour the prd behaviour table:
  delete-project drops that project's sessions everywhere but keeps the homes;
  delete-home drops one machine's convos but keeps the project files.

  New pure exports (all path-only, unit-testable): `SESSIONS_DIRNAME`,
  `machineAgentDir`, `machineSessionsDir`, `machineProjectSessionDir`,
  `resolveDeleteHome` (-> `DeleteHomePlan`), and `resolveDeleteProject`
  (-> `DeleteProjectPlan`).

- 0cd3698: Add `anon-pi init`: the honest, re-runnable onboarding that captures the
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

- 6f37dfa: Rewrite the `src/cli.ts` launch path onto the machines + projects workspace
  surface (grammar A). This is the breaking cutover from the 0.4.0 per-workdir
  model.

  - **Grammar A parsing** (new pure `parseLaunchArgs` in `src/anon-pi.ts`): a bare
    positional is a PROJECT; `-m <machine>` picks the machine; `--shell [<p>]` runs
    a jailed bash; `--mount <parent> [<p>]` roots at a HOST parent; `--keep`/`--rm`
    (throwaway default); the `.` root token; trailing `<pi-args…>` after the
    project are forwarded to pi verbatim. Enforces the reserved-name guard (via
    `validateName`) and rejects unknown options / a missing `-m`/`--mount`
    argument / a contradictory `--keep --rm`. `DEFAULT_MACHINE` = `default`.
  - The CLI reads `config.json` / a machine's `machine.json`, resolves the machine
    (`-m` > `config.defaultMachine` > `default`) + its image (machine.json, else
    `ANON_PI_IMAGE`), the forced-egress inputs (proxy REQUIRED/fail-closed, llm),
    and the projects root, then resolves the `RunPlan` (pure `resolveRunPlan`) and
    spawns `netcage` with inherited stdio, propagating the exit code. The composed
    argv ALWAYS carries `--proxy` + the one `--allow-direct` (the RunPlan's
    guarantee; the CLI never strips or adds egress).
  - **No-TTY discipline**: the bare menu and every interactive launch (interactive
    pi, a shell) require a TTY and error clearly without one; a headless
    `<project> <pi-args…>` run does not.
  - **Run-vs-start**: under `--keep`, the CLI queries netcage for its kept
    `netcage.managed` containers (stamping/reading back an `anon-pi.key` label) and
    `netcage start`s a matching one (pure `resolveRunVsStart`), else `netcage run`
    without `--rm`; `--rm`/default is always a fresh `netcage run --rm`.
  - Bare launch dispatches to a menu hook (a stub that points the user at direct
    launch; the interactive TUI lands in the follow-on task).

  **Breaking / removed** (migration for 0.4.0 users): a bare positional is now a
  PROJECT, not a host WORKDIR path; `--ephemeral`/`--fresh` and the `import`
  subcommand are gone from the CLI (their replacements `--rm` / `init` /
  `--delete-home` land in the surrounding tasks), and the per-workdir
  `state/<slug>/` home model is not migrated. The `HELP` string is rewritten to
  the new model. The old pure symbols (`buildRunPlan` / `stateAgentDir` /
  `resolveConfigSeed` / `pickProviderForLlm` / `resolveSourceModelsPath`) and the
  dead `AnonPiEnv` fields remain defined-and-exported (their deletion is the
  follow-on `retire-legacy-pure-surface` task), so the build stays green.

- 8b74d40: Add the `anon-pi machine {create,list,set-image,rm}` verbs to `src/cli.ts`,
  making machines first-class (an image + a persistent host home,
  `machines/<name>/{machine.json,home/}`). Dispatch stays thin; the parse,
  validation, machine.json serialisation, and the set-image warning wording live
  in the pure module (`src/anon-pi.ts`).

  - **`machine create <name> [--image <ref>]`**: validates the name (reserved-name
    / traversal guard via `validateName`), writes `machines/<name>/machine.json` +
    `home/`, and pins the image (from `--image`, else a TTY prompt; a non-TTY
    create without `--image` aborts). The home is a dir only here; it is SEEDED on
    first LAUNCH, not at create. Refuses to clobber an existing machine.
  - **`machine list`**: prints each machine and its pinned image (reads each
    machine's `machine.json`; a missing image shows `(no image)`). An empty
    workspace reports so clearly.
  - **`machine set-image <name> <ref>`**: RE-PINS the image and prints a
    compatibility WARNING only. It does NOT reseed or touch the home (the home's
    extensions / downloaded tools were built for the OLD image); the warning names
    the two remedies (`pi install` inside the machine, or `--delete-home` to
    reseed). Preserves a per-machine `projects` override across the re-pin.
  - **`machine rm <name> [--yes]`**: deletes the machine dir (its `machine.json` +
    home) after a confirm, mirroring the destructive-verb discipline: confirm on a
    TTY, `--yes` / `-y` skips it, and a non-TTY WITHOUT `--yes` ABORTS (never
    deletes unprompted in a script).

  New pure exports: `parseMachineArgs` (the `machine <verb> …` grammar ->
  `MachineCommand`), `serializeMachineJson`, and `setImageWarning`. The `machine`
  subcommand is dispatched before the launch grammar, so `machine` is never parsed
  as a project name.

- dfd894a: Align the shipped images with the machines + projects vocabulary: the container
  projects root is now `/projects` (was `/work`), so the concept is "project"
  everywhere and the images agree with the RunPlan's paths.

  - `Dockerfile.pi` and `examples/Dockerfile.pi-webveil`: `WORKDIR` is now
    `/projects` (the projects-root cwd, pi's default). `/work` is kept as the
    DISTINCT `--mount` root, so the two roots never collide.
  - The staged `trust.json` (in `/opt/anon-pi-seed/agent`, promoted into the
    machine home on first launch) now trusts BOTH cwd roots pi launches into,
    `/projects` and `/work`, so pi never prompts on the mounted project on any
    launch mode.
  - `Dockerfile.pi` seeds base `/root` shell dotfiles (`.bashrc`, `.profile`) from
    `/etc/skel` if absent, so a fresh machine home has defaults to fall back to
    (the home bind-mounts over `/root`).

- dd9cc4f: Add the per-machine RunPlan resolver (`resolveRunPlan`) to `src/anon-pi.ts`: the
  pure heart of the machines + projects rework. Given a resolved launch intent
  (machine + mode + project token + the forced-egress inputs) it composes the
  `netcage` argv for every launch mode, holding the forced-egress invariant on
  every path.

  - Modes (`LaunchMode`, `LaunchIntent`, `LaunchPlan`): `menu` (bare) yields an
    argv-less marker (the host-side TUI runs first); `pi <project>` cwds into
    `/projects/<project>` (or `/projects` for `.`) and forwards `<pi-args…>` to
    `pi`; `shell [project]` runs `bash` at `/root` (the machine home) or the
    project cwd; `--mount <parent>` re-roots into `/work[/<project>]`.
  - The TWO invariant container mounts are ALWAYS present: `<home>:/root` and
    `<projects-root>:/projects`. `--mount` adds EXACTLY one parent mount at a
    distinct `/work` and changes nothing else (sidesteps podman mount
    immutability).
  - `--rm` (throwaway) is the DEFAULT; `--keep` omits it to leave a kept
    container. The machine home mount survives on every path (it is a host mount).
  - Marker-guarded seed-if-fresh keyed per MACHINE home (reuses the
    `containerRunCmd` seed shape re-pointed at `/root`), promoting the image's
    staged pi defaults + the generated `models.json` into a fresh home once.
  - Forced egress is a HARD invariant: every composed argv carries `--proxy <p>`
    and exactly one `--allow-direct <llm>`; a plan can never be produced without
    the proxy or the direct hole (fail-closed).
  - Adds the `CONTAINER_HOME_ROOT` (`/root`) constant for the machine home bind
    path, distinct from the `~` menu token.

  Additive: the legacy per-workdir `buildRunPlan` (still called by `cli.ts`) is
  left dead-but-present; its coordinated removal is owned by a later task.

- 18a8e89: Add the pure machine + project resolvers, name validation, and the `.` root
  token to `src/anon-pi.ts` (built on the workspace-layout foundation).

  - Name validation (`validateName`, `NameKind`, `RESERVED_NAMES`): a machine or
    project name must be a single folder segment. Rejects `/ \ :`, whitespace, a
    leading dot (incl. `.`), the `..` traversal token, and reserved names, raising
    `AnonPiError` with a clear message naming the kind.
  - Project resolvers: `projectHostDir(projectsRoot, name)` maps a validated name
    to its host subfolder under the resolved projects root, and
    `projectContainerCwd(name)` gives the jail cwd `/projects/<name>` (pi's
    conversation key).
  - The `.` root token (`ROOT_TOKEN`, `isRootToken`) and a uniform cwd resolver
    (`resolveCwd`, `rootCwd`, `RootKind`): `.` means "the root itself" in every
    context, mapping to `/projects` (`CONTAINER_PROJECTS_ROOT`), `/work`
    (`CONTAINER_MOUNT_ROOT`, `--mount`), or `~` (`CONTAINER_MACHINE_HOME`, a
    machine home). A named project resolves to `<root>/<name>` under the projects
    or mount roots; a machine root takes only `.`.

  Pure and additive (no filesystem side effects); the CLI wires these to real
  dirs and composes the netcage argv in later tasks.

- 88b68f4: Add the pure bare-launch menu choice-list + per-machine project-usage record to
  `src/anon-pi.ts` (the data the host-side menu renders; the TUI is a later task).

  - `projectSessionSlug(name)`: the pi session-dir slug for a project, i.e.
    `pathSlug` of its jail cwd `/projects/<name>`. It is MACHINE-INVARIANT (the
    cwd is the same on every machine, since files are global), so the same shared
    project is recognised in each machine's `sessions/` dir. Matches pi's own
    session-manager convention (`--projects-<name>--`).
  - `buildMenuChoiceList({projects, canNew?, canShell?})` -> `MenuChoiceList`
    `{ projects, here, canNew, canShell }`: computed from a SUPPLIED projects-root
    listing. Non-project entries (dotfiles, `..`, separators, whitespace, reserved
    tokens) are dropped; surviving names are sorted case-insensitively for a
    stable menu; `here` is the `.` root token (a scratch pi at the root itself);
    `canNew` / `canShell` default true (affordance gates for later policy).
  - `deriveProjectUsage({projects, currentMachine, sessions})` -> `ProjectUsage[]`
    `{ project, machines, currentMachineIsNew }`: DERIVED from a SUPPLIED
    per-machine session-dir listing (`SessionDirListing`, no marker file). Each
    project maps to the (sorted) machines whose home contains its session slug,
    preserving the supplied project order; `currentMachineIsNew` is true when the
    current machine has no session dir for the project yet.

  Pure and additive (no filesystem side effects): the CLI reads the real projects
  root + each machine home's `sessions/` dir and renders the menu in a later task.

- ee7d2bb: Add a PURE `models.json` generator (`generateModelsJson`) to `src/anon-pi.ts`:
  given a single `llm` endpoint (a URL, `ip:port`, or bare ip), it returns a
  barebones pi `models.json` carrying exactly ONE local provider pointed at that
  endpoint. This replaces the old `import`-from-host-models.json flow as the source
  of the seed provider (used by `init` / seed-if-fresh to seed each machine home).

  - The endpoint is normalised with the existing `hostPortKey` helper (drops
    scheme / path / `user:pass@`, lowercases), so every endpoint form produces the
    same single-provider output.
  - It reads NO host pi `models.json`: no other provider, no paid API key, no
    session identity can leak into the seed (the anonymity hygiene the old `import`
    path preserved is now guaranteed by construction).
  - The generated provider uses a neutral, host-agnostic key (`LOCAL_PROVIDER_NAME`
    = `local`), the OpenAI-compatible completions dialect
    (`LOCAL_PROVIDER_API` = `openai-completions`) that local model servers
    overwhelmingly speak, a benign non-secret apiKey (`none`), and a
    `http://<host[:port]>/v1` baseUrl.

  This change is ADDITIVE: the legacy `import`-source symbols
  (`pickProviderForLlm` / `resolveSourceModelsPath`) and their tests are left in
  place (still read by `cli.ts`'s `import` path); their removal is owned by a later
  task.

- 6652498: Add the pure run-vs-start decision rule for kept (`netcage.managed`) containers
  to `src/anon-pi.ts`. For the exploratory `--keep` flow, decide whether a
  re-entered launch resumes an existing kept container (`netcage start`) or runs a
  fresh one (`netcage run` without `--rm`).

  - `keptContainerKey(intent)`: the launch-identity match key, derived ENTIRELY
    from the (machine, projects-root, project) identity (machine name +
    projects-root + `--mount` parent + the resolved container cwd, which encodes
    the project token and pi's conversation key). Excludes `--keep`/`--rm`, the
    forced-egress inputs, forwarded pi args, and the seed (see ADR-0002). anon-pi
    invents NO registry file: netcage's `netcage.managed` label IS the record.
  - `resolveRunVsStart(intent, listing)`: the pure decision. `--rm` (throwaway)
    ALWAYS resolves to a fresh `run` and never consults the listing; `--keep`
    resolves to `start` (with the matched container's ref) when a kept container
    whose key equals this launch's `keptContainerKey` is present, else `run`.
  - The netcage QUERY (asking netcage for its labelled containers) is an injected
    seam: the pure rule receives its RESULT (`KeptContainer[]`), so the decision
    is a pure function of (intent, listing) and unit-tested with fixture listings
    (present / absent / `--rm` short-circuit / match-key correctness). No real
    netcage/podman is invoked.

  The CLI that runs the real query and spawns `netcage start`/`run` is a later
  task.

- 34ec17a: Add the pure workspace-layout foundation for the machines + projects model.

  The anon-pi home now defaults to `~/.anon-pi/` (overridable by `ANON_PI_HOME`,
  no longer under `~/.config`). New pure resolvers in `src/anon-pi.ts`:
  machine/projects layout paths (`machineDir`, `machineHomeDir`, `machineJsonPath`,
  `builtinProjectsRoot`), `config.json`/`machine.json` parsers (`parseConfigJson`,
  `parseMachineJson`), and the load+merge resolvers with the decided precedence:
  projects-root `--mount` (later) > `ANON_PI_PROJECTS` > `machine.json.projects` >
  `config.json.projects` > built-in `~/.anon-pi/projects/`; proxy/llm env over
  config, with the proxy REQUIRED and fail-closed (verbatim guidance). This is
  additive: the legacy `buildRunPlan`/`import` seed + state paths still read the
  old `~/.config/anon-pi` layout and are retired by later tasks.

### Patch Changes

- 84e09f3: Polish + docs, resolving two filed observations:

  - `anon-pi init`'s proxy findings now show the host-wide process hint ONCE (as a
    general note) instead of gluing it onto every probed port line (including
    closed ports it was unrelated to). `formatProxyFindings` gained an optional
    host-wide `processNote` param; the per-finding rendering is kept for backward
    compatibility.
  - `anon-pi machine --help` (and `-h`) now reach the machine help (`MACHINE_HELP`)
    instead of the global help: the top-level `--help` intercept now excepts
    `machine` as well as `init` (the subcommands that own their own help).
  - Refreshed the stale top-of-file docblock in `src/anon-pi.ts` (it still
    described the retired 0.4.0 per-workdir model) and removed the now-dead
    `CONTAINER_WORKDIR` constant.
  - README: added a "Common tasks" quick-reference, a first-session walkthrough,
    and a Troubleshooting section; noted per-subcommand `--help`.

- 3fefd6d: Rewrite the README around the shipped **machines + projects** model and add a
  0.4.0 migration note.

  The README now documents the landed CLI surface (verified against `src/cli.ts` +
  the pure `HELP`): machines (image + persistent host home at `/root`), projects
  (folders under the projects root, mounted at `/projects/<name>`, the conversation
  key), `anon-pi init` onboarding, the bare-launch interactive **menu**, the
  `--shell` project-hopper (pi can't `cd` mid-session), the `--mount <parent>`
  host-parent caveat (`/work`), the throwaway-default (`--rm`) with `--keep` for a
  kept container, the `machine …` verbs and the `--delete-home` / `--delete-project`
  data verbs, env-vars-as-overrides, the `~/.anon-pi/` layout, and the
  forced-egress honesty (evidence via `netcage verify`'s exit IP, never a claim
  about the exit provider).

  A **Migrating from 0.4.0** section documents the breaking change for existing
  users: a bare positional is now a PROJECT (not a host path; host folders use
  `--mount`); `import` / `--fresh` / `--ephemeral` are removed (→ `init` /
  `--delete-home` + `--delete-project` / `--rm` + `--keep`); the old
  `~/.config/anon-pi/state/<slug>/` is NOT migrated (delete it); and the workspace
  moved to `~/.anon-pi/`.

  Adds a `readme-drift.test.ts` rung-1 guard that fails if the README re-introduces
  the retired 0.4.0 vocabulary or drops the landed surface.

- 6dbe0a4: Retire the orphaned legacy pure surface left over from the 0.4.0 per-workdir
  model, now that `cli.ts` reads none of it. Pure code + test deletion, no
  behaviour change.

  Removed from `src/anon-pi.ts` (all dead once `cli-launch-surface-grammar-a`
  rewrote the CLI onto the machines + projects resolvers): the five legacy
  functions `buildRunPlan` (old per-workdir shape), `stateAgentDir`,
  `resolveConfigSeed`, `pickProviderForLlm`, `resolveSourceModelsPath`; the dead
  `AnonPiEnv` fields `ephemeral` / `configSeed` / `sourceModels` (plus
  `piAgentDir`, orphaned with `resolveSourceModelsPath`) and their `envFromProcess`
  env-key mappings (`ANON_PI_EPHEMERAL` / `ANON_PI_CONFIG` / `ANON_PI_SOURCE_MODELS`
  / `PI_CODING_AGENT_DIR`); and the now-unreferenced supporting declarations
  (`RunPlan` interface, `ImportResult` interface, `legacyAnonPiHome`,
  `BENIGN_API_KEYS`, the `isTruthy` helper) that existed only to serve them.

  The corresponding `anon-pi.test.ts` describe blocks are deleted; the surviving
  surface (`resolveAnonPiHome`, `hostPortKey`, `pathSlug`, the new layout/config
  resolvers, `resolveRunPlan`, `generateModelsJson`) is kept untouched.

## 0.4.0

### Minor Changes

- c92f296: Add `anon-pi --fresh [WORKDIR]`: delete this workdir's persistent state home
  before launching, so the (possibly rebuilt) image's staged defaults and your
  imported `models.json` are re-seeded on this launch. Use it after rebuilding your
  image to pick up new extensions/config without hand-deleting the state dir.
  `--fresh` with `--ephemeral` is rejected (an ephemeral session is always fresh).

## 0.3.0

### Minor Changes

- 77f44f0: Make `ANON_PI_PROXY` required; remove the `socks5h://127.0.0.1:9050` default.
  anon-pi is an anonymity tool, so the proxy is the single most important input and
  must never be guessed: a silent default can anonymize through the wrong endpoint
  (or none) and fail confusingly deep in the jail. It now errors like
  `ANON_PI_IMAGE`/`ANON_PI_LLM` when unset, mirroring netcage, which itself refuses
  to run without `--proxy` (fail-closed). The error lists copy-paste `export` lines
  for the common proxies (Tor on `9050`, wireproxy/ssh -D on `1080`).
- e0eb4b1: Make anon-pi STATEFUL: persist pi's home across launches, with first-launch
  seeding (Model B + C).

  - anon-pi now mounts a persistent per-workdir host dir at the container's
    `~/.pi/agent`, so sessions, history, settings (your model choice), and any
    extensions you `pi install` all survive across launches. Re-running in the
    same folder resumes it. The state dir is `<ANON_PI_HOME>/state/<workdir>/agent`,
    named with pi's own readable path convention (not a hash).
  - First-launch seed-if-fresh: on a fresh home the image's staged defaults
    (`/opt/anon-pi-seed/agent`: extensions, `trust.json`) and your imported
    `models.json` are promoted in once and a `.anon-pi-seed` marker is stamped;
    thereafter pi owns the home and nothing is clobbered. Resolves the "changed my
    model / installed an extension and it forgot" and the repeated `fd` download.
  - `--ephemeral` / `ANON_PI_EPHEMERAL=1`: mount NO writable state. pi writes to
    the container's own `--rm` layer, destroyed on exit, so nothing writable ever
    touches a host path, there is no cleanup, and nothing is left behind even on a
    crash. (Only the read-only models.json seed is mounted.)
  - Images now install extensions + config into the STAGING dir
    (`PI_CODING_AGENT_DIR=/opt/anon-pi-seed/agent pi install ...`), not
    `~/.pi/agent` (which is the mount and would be shadowed). Updated `Dockerfile.pi`
    and `examples/Dockerfile.pi-webveil`.

### Patch Changes

- 7bcdf33: Accept a URL-form `ANON_PI_LLM`. netcage's `--allow-direct` wants a bare
  `IP[:port]`/CIDR, but users naturally set `ANON_PI_LLM` to a URL like
  `http://192.168.1.150:8080`. anon-pi now strips the scheme/path (the same
  normalization `import` already uses) before passing it to `--allow-direct`, so a
  URL, an `ip:port`, or a bare IP all work.
- 7dcf96a: The missing-`ANON_PI_IMAGE` error now also offers a copy-paste build for the
  fuller `examples/Dockerfile.pi-webveil` (pi + the pi-webveil extension + a local
  SearXNG), alongside the simple `Dockerfile.pi`, each resolved to its real shipped
  path.

## 0.2.0

### Minor Changes

- 76a99a0: Add `anon-pi import` and reshape the seed model so image-installed extensions
  survive.

  - `anon-pi import` generates the seed from your local model: it reads your host
    `~/.pi/agent/models.json`, picks the provider whose `baseUrl` serves
    `ANON_PI_LLM`, and writes just that provider to `<ANON_PI_CONFIG>/models.json`.
    No other provider's API keys, no sessions, no identity. Errors on no match,
    warns on a real-looking `apiKey`, refuses to overwrite without `--force`.
  - The seed is now just `models.json`. anon-pi mounts it read-only and **copies**
    it into the container's own `~/.pi/agent` at start (instead of mounting a
    whole config dir as `PI_CODING_AGENT_DIR`), so extensions/skills baked into the
    image are no longer shadowed. pi auto-selects the local model (no default
    needed). Removed `ANON_PI_AGENT_MOUNT` and the per-session seed copy.
  - README + `Dockerfile.pi`: document that extensions, skills, and their services
    (e.g. `pi-webveil` + searxng) belong in the image, installed via `pi install`.
  - Ship a worked `examples/Dockerfile.pi-webveil`: pi + pi-webveil + a local
    SearXNG over a Unix socket (http-socket, json+limiter:false, `unix:` baseUrl,
    `egress: direct`), started by an entrypoint that then execs anon-pi's command.
    It documents why the usual local-SearXNG anonymity caveat does not apply
    in-jail (netcage forces every process's egress through the proxy).

### Patch Changes

- 0f8f76c: Make the missing-`ANON_PI_IMAGE` error copy-pasteable. The previous version
  printed an indented `Dockerfile.pi` heredoc, so pasting it baked leading spaces
  into the file and broke the `EOF` terminator. Now the error points at the
  `Dockerfile.pi` that ships with the package (resolved to its real absolute path)
  and emits a flush-left `podman build` + `export` you can paste as-is.

## 0.1.1

### Patch Changes

- 8ad9f14: Make the missing-`ANON_PI_IMAGE` error actionable: instead of a one-line dead
  end, it now prints a ready-to-build `Dockerfile.pi` recipe (the upstream pattern
  that installs `@earendil-works/pi-coding-agent`) plus the `podman build` and
  `export ANON_PI_IMAGE` commands, and points at the shipped `Dockerfile.pi` /
  README. `--help` gains a matching hint.

## 0.1.0

### Minor Changes

- e99c7cf: Initial release. anon-pi is a thin, opinionated launcher over `netcage run` that
  starts pi with all web/DNS egress forced through a socks5h proxy (fail-closed),
  one direct hole to a local model on the LAN, and a per-workdir seeded pi config
  on the host. Requires `netcage` on PATH and an `ANON_PI_IMAGE` with `pi` on it
  (a `Dockerfile.pi` is included).
