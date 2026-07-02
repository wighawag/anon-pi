# anon-pi

Launch [pi](https://github.com/earendil-works/pi-mono) inside a [netcage](https://github.com/wighawag/netcage): all of pi's web and DNS egress is forced through a socks5h proxy (fail-closed, leak-proof), while ONE direct hole is opened to a local model on your LAN. Your pi config is seeded, per-workdir, onto the host; your canonical config is never touched by the container.

anon-pi is a thin, opinionated launcher over `netcage run`. It is a separate package on purpose: netcage wraps any tool and stays tool-agnostic; anon-pi holds the pi-specific opinion.

## Requirements

- **Linux.** anon-pi inherits netcage's platform reality (network namespaces + nftables + rootless Podman). See [Platform](#platform).
- **[`netcage`](https://github.com/wighawag/netcage)** on your `PATH`.
- A running **socks5h proxy** (local Tor, `ssh -D`, ...).
- A **container image with `pi` on its `PATH`** (you provide it via `ANON_PI_IMAGE`; see [Providing a pi image](#providing-a-pi-image)).

## Install

```sh
npm i -g anon-pi
# or run without installing:
npx anon-pi
```

## Usage

```sh
anon-pi [WORKDIR]
```

- `WORKDIR` is the host folder pi works in (mounted at `/work`; pi's cwd). Defaults to the current directory. Files pi writes to `/work` land in this folder on the host.
- The session config+state is keyed to this folder: re-running `anon-pi` on the same folder **resumes** the same pi config and history.

```sh
export ANON_PI_IMAGE=your/pi-image:tag
export ANON_PI_LLM=192.168.1.150:8080     # your local model, reached directly
export ANON_PI_PROXY=socks5h://127.0.0.1:9050

anon-pi import       # one-time: generate the seed models.json from your model
anon-pi ./recon      # launch
```

You land in pi, inside the jail, cwd `/work` = `./recon`. pi's web/tool egress is anonymized through the proxy; the local model at `ANON_PI_LLM` is reachable directly; everything else is dropped if the proxy is down (fail-closed).

## Environment

| Var | Required | Default | Meaning |
| --- | --- | --- | --- |
| `ANON_PI_IMAGE` | for run | | container image with `pi` on `PATH` |
| `ANON_PI_LLM` | yes | | RFC1918/link-local `IP[:port]` of the local model (the one direct hole) |
| `ANON_PI_PROXY` | no | `socks5h://127.0.0.1:9050` | the socks5h proxy |
| `ANON_PI_HOME` | no | `$XDG_CONFIG_HOME/anon-pi` or `~/.config/anon-pi` | anon-pi home |
| `ANON_PI_CONFIG` | no | `<ANON_PI_HOME>/agent` | the seed dir (holds `models.json`) |
| `ANON_PI_SOURCE_MODELS` | no | `~/.pi/agent/models.json` | (`import`) the host `models.json` to read from |

## How it works

1. **Seed = just `models.json`.** `anon-pi import` writes one file, `<ANON_PI_CONFIG>/models.json`, containing only the provider that serves your local model (see [Generating the seed](#generating-the-seed-anon-pi-import)). No auth for other providers, no sessions, no identity.
2. **Mount read-only + copy in.** anon-pi mounts the seed read-only at `/anon-pi-seed` and, at start, **copies** `models.json` into the container's own `~/.pi/agent`. It does **not** mount over pi's config dir, so anything the image installed there (pi itself, extensions, skills) survives; the copy just adds your local model to it.
3. **Run.** anon-pi execs `netcage run --proxy <proxy> --allow-direct <ANON_PI_LLM> -it -v <workdir> -v <seed>:/anon-pi-seed:ro <image> sh -c 'cp /anon-pi-seed/models.json ~/.pi/agent/ && exec pi'`.

pi has no default model set in the seed, so on start it auto-selects the first available model, your local one (it needs no real API key). Everything that runs, and everything that identifies you, lives in the **image**, not the seed (see below).

## Providing a pi image

anon-pi does not ship or default an image: you set `ANON_PI_IMAGE` to an image that has the `pi` CLI on its `PATH`. pi's maintainers do not publish an official prebuilt image, so the reputable path is to **build a small one from the upstream-documented recipe** (which installs the official [`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) npm package, no third-party image to trust).

A ready `Dockerfile.pi` ships in this package (adapted from pi's own [containerization docs](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/containerization.md)):

```sh
# from wherever this package's Dockerfile.pi is (e.g. node_modules/anon-pi)
podman build -t localhost/anon-pi-pi:latest -f Dockerfile.pi .
export ANON_PI_IMAGE=localhost/anon-pi-pi:latest
```

The image only needs `pi` reachable on `PATH`. anon-pi passes `pi` as the run command (via a small copy-then-exec step) and never mounts over pi's config dir, so the image needs **no `ENTRYPOINT` and no config volume** (unlike pi's upstream `Dockerfile.pi`, which is written for running pi directly).

A community image also exists ([`gni/pi-coding-agent-container`](https://github.com/gni/pi-coding-agent-container)); it is third-party and unvetted, so review it yourself before trusting it with your (anonymized) credentials.

### Extensions, skills, and their services go in the image

anon-pi deliberately imports **only your local model** (see below), never your extensions or skills. That is on purpose: your extension set is an identity fingerprint, extensions run code and can leak, and many need a runtime that a copied folder cannot carry (for example `pi-webveil` needs a running searxng). The right home for capabilities is the **image**, where they are installed once, reviewably, with clean config:

```dockerfile
FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      bash ca-certificates git ripgrep && rm -rf /var/lib/apt/lists/*
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent

# Extensions are installed with `pi install` (which records them in settings),
# NOT a global npm install:
# RUN pi install npm:pi-webveil
# ...and an extension that needs a service (pi-webveil -> searxng) also installs
# and configures that service in the image. Its egress is forced through the
# socks proxy by netcage at runtime, so it must be happy with proxy-only,
# DNS-through-proxy networking.

WORKDIR /work
```

Because anon-pi copies `models.json` **into** the image's own `~/.pi/agent` rather than replacing it, extensions installed in the image stay active in the anon session.

## Generating the seed (`anon-pi import`)

anon-pi **never** copies your real pi config. Instead, `anon-pi import` synthesizes a minimal seed from your local model:

```sh
export ANON_PI_LLM=192.168.1.150:8080
anon-pi import
```

It reads your host `~/.pi/agent/models.json` (override with `ANON_PI_SOURCE_MODELS`), finds the provider whose `baseUrl` serves `ANON_PI_LLM` (matched on host:port, so `192.168.1.150:8080` matches `http://192.168.1.150:8080/v1`), and writes **just that provider** to `<ANON_PI_CONFIG>/models.json`. Everything else, your paid providers and their API keys, your sessions, your trust list, your extensions, is left behind on the host.

- If no provider matches `ANON_PI_LLM`, it errors and lists the providers it did find.
- If the matched provider carries a real-looking `apiKey` (not `none`/`ollama`/empty), it warns but proceeds (for a local model this is usually fine).
- It refuses to overwrite an existing seed unless you pass `--force`.

To reseed (e.g. after changing your local model), re-run `anon-pi import --force`.

## Trusting `/work`

pi treats a mounted project as untrusted until approved. For a smooth start, have the **image** trust `/work` (bake a `trust.json` mapping `/work` to `true` into the image's `~/.pi/agent`), or approve once inside a session. anon-pi does not synthesize pi's `trust.json`; it belongs in the image, alongside the extensions.

## Overriding the config per workdir

pi also supports a **project-local** config at `<cwd>/.pi/`, which layers on top of the image's global config. Since your workdir is pi's cwd (`/work`), you can drop a `/work/.pi/` (i.e. `<workdir>/.pi/`) into the folder to override settings for that folder only. anon-pi does nothing special for this; it is pi's normal project-over-global layering.

## Platform

anon-pi is **Linux-only**, because netcage's jail is built on Linux kernel primitives (network namespaces, nftables, `/dev/net/tun`, rootless Podman + pasta). There is no native macOS/Windows jail.

On macOS/Windows, Podman runs inside a Linux VM (`podman machine`), so netcage (and anon-pi) can run **inside that VM**. Two caveats matter for anon-pi:

- **`--allow-direct` to a LAN model is VM-boundary-sensitive.** "Directly over the LAN" means the *VM's* NIC, not your Mac/Windows host LAN, so a model at an RFC1918 address on the host network may not be directly reachable from inside the VM the way it is on bare Linux.
- **Host-loopback proxy reachback** (`ssh -D`/Tor on the host's `127.0.0.1`) is the host loopback, not the VM's.

Treat non-Linux as best-effort-via-VM, not supported.

## License

[AGPL-3.0-only](./LICENSE)
