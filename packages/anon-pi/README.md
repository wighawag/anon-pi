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

anon-pi ./recon
```

You land in pi, inside the jail, cwd `/work` = `./recon`. pi's web/tool egress is anonymized through the proxy; the local model at `ANON_PI_LLM` is reachable directly; everything else is dropped if the proxy is down (fail-closed).

## Environment

| Var | Required | Default | Meaning |
| --- | --- | --- | --- |
| `ANON_PI_IMAGE` | yes | | container image with `pi` on `PATH` |
| `ANON_PI_LLM` | yes | | RFC1918/link-local `IP[:port]` of the local model (the one direct hole) |
| `ANON_PI_PROXY` | no | `socks5h://127.0.0.1:9050` | the socks5h proxy |
| `ANON_PI_HOME` | no | `$XDG_CONFIG_HOME/anon-pi` or `~/.config/anon-pi` | anon-pi home |
| `ANON_PI_CONFIG` | no | `<ANON_PI_HOME>/agent` | the canonical seed dir |
| `ANON_PI_AGENT_MOUNT` | no | `/opt/pi-agent` | absolute container path pi's config is mounted at (see below) |

## How it works

1. **Seed (once per workdir).** The first time you use a workdir, anon-pi copies your canonical config (`~/.config/anon-pi/agent`) into a per-session dir `~/.config/anon-pi/sessions/<hash-of-workdir>/agent`. The canonical config is only ever READ; it is never mounted into the container, so pi in the jail cannot mutate it.
2. **Mount.** The session config dir is mounted as pi's global config (`PI_CODING_AGENT_DIR=<mount>`, default `/opt/pi-agent`), and the workdir is mounted at `/work`.
3. **Run.** anon-pi execs `netcage run --proxy <proxy> --allow-direct <ANON_PI_LLM> -it -v <workdir> -v <session>:<mount> -e PI_CODING_AGENT_DIR=<mount> <image> pi`.

### Where pi's config is mounted (`ANON_PI_AGENT_MOUNT`)

By default anon-pi mounts the seeded config at `/opt/pi-agent` and points pi there with `PI_CODING_AGENT_DIR`. This absolute, image-independent path is chosen so the podman mount target and pi's config dir agree without anon-pi having to guess your image's home directory.

If you would rather pi's config live at its **standard** `~/.pi/agent` inside the container, set `ANON_PI_AGENT_MOUNT` to that home's **absolute** path, e.g. `ANON_PI_AGENT_MOUNT=/root/.pi/agent` for an image that runs as `root` (or `/home/<user>/.pi/agent` otherwise). The value must be absolute: podman does not expand `~`, and anon-pi rejects a `~`-relative or relative value rather than mounting it at a literal `~` directory. Both the mount target and `PI_CODING_AGENT_DIR` always stay in lockstep.

## Providing a pi image

anon-pi does not ship or default an image: you set `ANON_PI_IMAGE` to an image that has the `pi` CLI on its `PATH`. pi's maintainers do not publish an official prebuilt image, so the reputable path is to **build a small one from the upstream-documented recipe** (which installs the official [`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) npm package, no third-party image to trust).

A ready `Dockerfile.pi` ships in this package (adapted from pi's own [containerization docs](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/containerization.md)):

```sh
# from wherever this package's Dockerfile.pi is (e.g. node_modules/anon-pi)
podman build -t localhost/anon-pi-pi:latest -f Dockerfile.pi .
export ANON_PI_IMAGE=localhost/anon-pi-pi:latest
```

The image only needs `pi` reachable on `PATH`. anon-pi passes `pi` as the run command and mounts pi's config itself, so the image needs **no `ENTRYPOINT` and no config volume** (unlike pi's upstream `Dockerfile.pi`, which is written for running pi directly).

A community image also exists ([`gni/pi-coding-agent-container`](https://github.com/gni/pi-coding-agent-container)); it is third-party and unvetted, so review it yourself before trusting it with your (anonymized) credentials.

## Populating the seed

anon-pi **never** populates the canonical config for you (it will not silently copy your real identity into the anon config). Create it yourself:

```sh
mkdir -p ~/.config/anon-pi/agent
cp -a ~/.pi/agent/. ~/.config/anon-pi/agent/
# then remove anything you do NOT want in the anonymized identity
```

Put the pi config you want anon sessions to use here: anonymously-created accounts / API keys, the models and skills you want, and a **`trust.json` that trusts `/work`** so pi does not prompt about the (mounted) project on every run. anon-pi does not synthesize pi's `trust.json`; getting a valid one into the seed is your responsibility (copy it from a pi setup where `/work` is trusted, or approve once inside a session and it persists in the session dir).

## Reseed

Reseed is a manual step: delete the session dir and the next run re-seeds it.

```sh
rm -rf ~/.config/anon-pi/sessions/<hash>/agent
```

## Overriding the config per workdir

The seeded config is pi's **global** in the container. pi also supports a **project-local** config at `<cwd>/.pi/`, which layers on top of the global. Since your workdir is pi's cwd (`/work`), you can drop a `/work/.pi/` (i.e. `<workdir>/.pi/`) into the folder to override the global for that folder only. anon-pi does nothing special for this; it is pi's normal project-over-global layering. (Make sure your seed's `trust.json` trusts `/work` so the override is honored without a prompt.)

## Platform

anon-pi is **Linux-only**, because netcage's jail is built on Linux kernel primitives (network namespaces, nftables, `/dev/net/tun`, rootless Podman + pasta). There is no native macOS/Windows jail.

On macOS/Windows, Podman runs inside a Linux VM (`podman machine`), so netcage (and anon-pi) can run **inside that VM**. Two caveats matter for anon-pi:

- **`--allow-direct` to a LAN model is VM-boundary-sensitive.** "Directly over the LAN" means the *VM's* NIC, not your Mac/Windows host LAN, so a model at an RFC1918 address on the host network may not be directly reachable from inside the VM the way it is on bare Linux.
- **Host-loopback proxy reachback** (`ssh -D`/Tor on the host's `127.0.0.1`) is the host loopback, not the VM's.

Treat non-Linux as best-effort-via-VM, not supported.

## License

[AGPL-3.0-only](./LICENSE)
