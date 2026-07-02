# anon-pi

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
