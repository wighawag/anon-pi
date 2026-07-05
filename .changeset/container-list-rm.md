---
'anon-pi': minor
---

Implement the `container list` and `container rm` verb bodies, completing the
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
