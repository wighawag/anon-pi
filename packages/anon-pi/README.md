# anon-pi

Launch [pi](https://github.com/earendil-works/pi-mono) inside a [tooljail](https://github.com/wighawag/tooljail): all of pi's web and DNS egress is forced through a socks5h proxy (fail-closed, leak-proof), while ONE direct hole is opened to a local model on your LAN. Your pi config is seeded, per-workdir, onto the host; your canonical config is never touched by the container.

anon-pi is a thin, opinionated launcher over `tooljail run`. It is a separate package on purpose: tooljail wraps any tool and stays tool-agnostic; anon-pi holds the pi-specific opinion.

## Requirements

- **Linux.** anon-pi inherits tooljail's platform reality (network namespaces + nftables + rootless Podman). See [Platform](#platform).
- **[`tooljail`](https://github.com/wighawag/tooljail)** on your `PATH`.
- A running **socks5h proxy** (local Tor, `ssh -D`, ...).
- A **container image with `pi` on its `PATH`** (you provide it via `ANON_PI_IMAGE`).

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

## How it works

1. **Seed (once per workdir).** The first time you use a workdir, anon-pi copies your canonical config (`~/.config/anon-pi/agent`) into a per-session dir `~/.config/anon-pi/sessions/<hash-of-workdir>/agent`. The canonical config is only ever READ; it is never mounted into the container, so pi in the jail cannot mutate it.
2. **Mount.** The session config dir is mounted as pi's global config (`PI_CODING_AGENT_DIR=/opt/pi-agent`), and the workdir is mounted at `/work`.
3. **Run.** anon-pi execs `tooljail run --proxy <proxy> --allow-direct <ANON_PI_LLM> -it -v <workdir> -v <session>:/opt/pi-agent -e PI_CODING_AGENT_DIR=/opt/pi-agent <image> pi`.

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

anon-pi is **Linux-only**, because tooljail's jail is built on Linux kernel primitives (network namespaces, nftables, `/dev/net/tun`, rootless Podman + pasta). There is no native macOS/Windows jail.

On macOS/Windows, Podman runs inside a Linux VM (`podman machine`), so tooljail (and anon-pi) can run **inside that VM**. Two caveats matter for anon-pi:

- **`--allow-direct` to a LAN model is VM-boundary-sensitive.** "Directly over the LAN" means the *VM's* NIC, not your Mac/Windows host LAN, so a model at an RFC1918 address on the host network may not be directly reachable from inside the VM the way it is on bare Linux.
- **Host-loopback proxy reachback** (`ssh -D`/Tor on the host's `127.0.0.1`) is the host loopback, not the VM's.

Treat non-Linux as best-effort-via-VM, not supported.

## License

MIT
