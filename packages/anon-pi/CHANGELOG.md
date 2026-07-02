# anon-pi

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
