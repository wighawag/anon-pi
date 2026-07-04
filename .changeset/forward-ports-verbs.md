---
'anon-pi': minor
---

Add `anon-pi forward` and `anon-pi ports`: reach an in-jail server from the host
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
