---
title: Run GUI apps in a jailed machine via a virtual-screen (Xvfb + VNC) image
slug: gui-apps-via-virtual-screen-image
---

# Run GUI apps in a jailed machine via a virtual-screen image

Proposed idea. Let a jailed anon-pi machine (and, once multi-persona lands, a persona) run GRAPHICAL applications, WITHOUT sharing the host display, by shipping a virtual-screen stack IN THE IMAGE and reaching it over a port. This is MOSTLY an IMAGE concern: anon-pi/netcage do not need to understand GUIs; they need an image that carries the headless-display stack plus one host-side seam to reach it.

## Why (and why not share the host display)

The whole point of a hardened persona is unlinkability + isolation. The lightweight route to GUI in a container is to bind-mount the host X/Wayland socket (`-v /tmp/.X11-unix`, `$DISPLAY`) so apps appear on your real desktop, but that PUNCHES A HOLE straight through the isolation: an app with your host X socket can keylog, screenshot, and read the clipboard of your WHOLE host session, and it re-associates the persona with your real display. That is exactly the leak this project exists to close, so sharing the host display is RULED OUT for a persona.

## The mechanism: a virtual screen inside the jail

Run the display server INSIDE the container as a virtual framebuffer, and reach it over a port (never the host display):

- **Xvfb** (X virtual framebuffer) or **Xephyr** provides a headless X display in the container; the GUI app renders to it.
- A **VNC server** (e.g. `x11vnc`) + optional **noVNC** (VNC-over-websocket, viewable in a browser) exposes that virtual screen.
- You connect to the VNC/noVNC PORT to see + drive the app. In the netcage world that port is reached via the existing **`forward` verb** (host -> jail port), so no host display socket is ever shared. The Wayland analogue is `weston`/`sway` headless + an RDP/VNC bridge.

Net: the GUI lives entirely on a virtual screen inside the jail; you view it through a forwarded port; the host display, clipboard, and input are never exposed. The DAC + forced-egress isolation is preserved, not broken.

## What anon-pi/netcage actually need (small)

- **An IMAGE that ships the stack** (Xvfb + x11vnc + noVNC + the GUI app). This is the bulk of the work and it is image-side (a `Dockerfile.pi-gui` alongside the existing shipped Dockerfiles), not launcher logic.
- **A documented `forward` recipe** to reach the VNC/noVNC port of a running machine (the mechanism already exists; this is docs + maybe a convenience).
- Rootless podman runs all of this fine (no privileged X, no host socket).

## Scope / relationship to other work

- **Mostly image, minimal launcher.** Keep it OUT of the multi-persona spec (`multi-persona-hardened-accounts`); it composes with a persona (a persona could use a GUI image) but does not depend on it and should not gate it.
- Composes with the `save-image-on-exit` / image ideas (a GUI machine is just a machine on a GUI image).
- Forced egress is unchanged: a GUI app's network still goes through the persona's proxy, fail-closed. The VNC port is a LOCAL host<->jail forward, not egress.

## Open threads

- Which VNC stack (x11vnc + noVNC vs a TigerVNC/TurboVNC route) for the shipped image; browser-viewable (noVNC) is the most frictionless.
- Whether anon-pi adds a convenience verb (e.g. `anon-pi gui <machine>` that launches + opens the forward + prints the URL) or leaves it as a documented `forward` recipe.
- Clipboard/file transfer INTO the persona (a deliberate, narrow bridge) if ever wanted — off by default (it is a re-linking surface).
- Performance (software-rendered framebuffer over VNC is fine for most apps; GPU accel is a separate, larger concern).
