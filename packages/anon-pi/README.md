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
| `ANON_PI_PROXY` | yes | | the socks5h proxy (Tor/wireproxy/ssh -D). No default: it is what anonymizes |
| `ANON_PI_EPHEMERAL` | no | (off) | set to `1` for a throwaway, non-persistent session |
| `ANON_PI_HOME` | no | `$XDG_CONFIG_HOME/anon-pi` or `~/.config/anon-pi` | anon-pi home |
| `ANON_PI_CONFIG` | no | `<ANON_PI_HOME>/agent` | canonical seed dir (holds the imported `models.json`) |
| `ANON_PI_SOURCE_MODELS` | no | `~/.pi/agent/models.json` | (`import`) the host `models.json` to read from |

## How it works

**Stateful by default.** anon-pi mounts a persistent per-workdir host dir at the container's `~/.pi/agent`, so pi's **sessions, history, settings (your model choice), and any extensions you `pi install`** all persist across launches. Re-running in the same folder resumes it. The state dir is `<ANON_PI_HOME>/state/<workdir>/agent`, named with pi's own readable path convention (e.g. `--home-me-proj--`), not a hash, so you can see which folder it belongs to and delete it to reset.

1. **Mount the persistent home.** `-v <ANON_PI_HOME>/state/<workdir>/agent:/root/.pi/agent`. Everything pi writes there survives.
2. **First-launch seed (only when the home is fresh).** anon-pi mounts the image's staged defaults and your imported `models.json`, and the container promotes them into the fresh home, then stamps a `.anon-pi-seed` marker. On later launches the marker is present, so nothing is re-copied and **your changes (added models, installed extensions) are never clobbered**.
3. **Run.** `netcage run --proxy <proxy> --allow-direct <ANON_PI_LLM> -it -v <workdir> -v <state>:/root/.pi/agent [-v <models.json>:...:ro] <image> sh -c '<seed-if-fresh> && exec pi'`.

pi auto-selects the first available model (your local one; it needs no real API key), so no default needs to be set. Services and default extensions live in the **image**; your state lives in the persistent home.

### Ephemeral (throwaway) sessions

For a clean, no-local-trace session, pass `--ephemeral` (or `ANON_PI_EPHEMERAL=1`): anon-pi uses a temporary home that is seeded the same way and **discarded on exit**. Nothing persists.

```sh
anon-pi --ephemeral ./scratch
```

### Reset a session

Delete its state home; the next launch re-seeds:

```sh
rm -rf ~/.config/anon-pi/state/<workdir-slug>/agent
```

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

Install image defaults into the **staging dir** (`PI_CODING_AGENT_DIR=/opt/anon-pi-seed/agent pi install ...`), NOT `~/.pi/agent`: anon-pi mounts a persistent home over `~/.pi/agent`, and promotes the staging dir into it on a fresh launch. Anything you then `pi install` *inside* a session also persists (it is written to the mounted home). See the `Dockerfile.pi` comments for the exact `pi install` form.

A worked example ships in this package: [`examples/Dockerfile.pi-webveil`](examples/Dockerfile.pi-webveil) builds pi + the `pi-webveil` extension (staged) + a local SearXNG (over a Unix socket, `http-socket` so webveil's `unix:` baseUrl can speak HTTP to it, JSON API on, limiter off), started by an entrypoint that then execs anon-pi's seed-then-pi command. Note the anonymity subtlety it documents: SearXNG's own crawl is anonymized here **because netcage forces every process's egress through the proxy**, so webveil's plain `egress: direct` is correct in-jail (the usual "local SearXNG leaks your IP" caveat does not apply).

## Generating the seed (`anon-pi import`)

anon-pi **never** copies your real pi config. Instead, `anon-pi import` synthesizes a minimal `models.json` from your local model:

```sh
export ANON_PI_LLM=192.168.1.150:8080
anon-pi import
```

It reads your host `~/.pi/agent/models.json` (override with `ANON_PI_SOURCE_MODELS`), finds the provider whose `baseUrl` serves `ANON_PI_LLM` (matched on host:port, so `192.168.1.150:8080` matches `http://192.168.1.150:8080/v1`), and writes **just that provider** to `<ANON_PI_CONFIG>/models.json`. Everything else, your paid providers and their API keys, your sessions, your trust list, is left behind on the host.

That file **seeds a fresh session home** (it is copied in on first launch). Models you later add *inside* pi persist in the session home and are never clobbered by import. To change what a fresh home seeds, re-run `anon-pi import --force`; to apply it to an existing session, reset that session (delete its state home).

- If no provider matches `ANON_PI_LLM`, it errors and lists the providers it did find.
- If the matched provider carries a real-looking `apiKey` (not `none`/`ollama`/empty), it warns but proceeds (for a local model this is usually fine).
- It refuses to overwrite the canonical seed unless you pass `--force`.

## Trusting `/work`

pi treats a mounted project as untrusted until approved. The shipped Dockerfiles stage a `trust.json` trusting `/work` (in `/opt/anon-pi-seed/agent`), which is promoted into the session home on first launch, so you are not prompted. You can also approve once inside a session; it persists.

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
