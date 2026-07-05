# Run-vs-start match key for kept (netcage.managed) containers

> SUPERSEDED (for kept-container matching) by ADR-0004: `--keep`/`--rm` and the
> run-vs-start inference are retired, so there are no kept containers to match
> and this ADR's match-key decision (`keptContainerKey` /`resolveRunVsStart`) no
> longer applies. What SURVIVES from this ADR is its (machine, project via cwd)
> identity reasoning, which still underpins the `anon-pi.key` label anon-pi
> stamps on EVERY (throwaway) launch so `forward`/`ports`/`snapshot` can resolve
> a RUNNING container (now produced by `launchIdentityKey`, decoded by
> `parseKeptKey`/`keyProject`). The ADR-0003 image-in-the-key amendment below is
> moot (there is no kept-container key to extend). Kept for the retained
> identity reasoning; not deleted.

> AMENDED by ADR-0003 (now MOOT, see the SUPERSEDED note above): the resolved
> IMAGE was to become part of the key. This ADR
> originally excluded the image (it was fixed per machine); once `-i <image>`
> makes the image variable per launch, two `--keep` launches differing only in
> image are distinct kept containers, so the image joins the key below.


For the exploratory `--keep` flow, anon-pi must decide whether a re-entered
launch resumes an existing kept container (`netcage start`) or runs a fresh one
(`netcage run` without `--rm`). ADR-0001 already fixed that netcage's
`netcage.managed` label IS the record (no anon-pi registry file). This ADR fixes
the exact IDENTITY that decides "same launch, same kept container".

## Decision

The match key (`keptContainerKey`) is derived ENTIRELY from the (machine,
projects-root, project) identity, as four fields:

- `machine.name` — a kept container mounts THIS machine's home at `/root`; the
  same project on another machine is a different environment.
- `projectsRoot` — the host dir mounted at `/projects`; the same project name
  under a different root is a different working tree.
- `mountParent` (empty when absent) — `--mount` re-roots into a different host
  parent at `/work`, so a `--mount` launch is a distinct identity from the
  projects-root launch of the same name.
- the resolved container `cwd` — this already encodes the project token
  (`/projects/<p>`, `/work/<p>`, a root for `.`, or `/root` for a bare shell)
  and which root it sits under, and it is also pi's conversation key, so keying
  on it aligns the kept container's identity with the conversation it hosts.

DELIBERATELY EXCLUDED from identity (two launches differing only in these must
resume the SAME kept container): `--keep`/`--rm` (the throwaway choice for THIS
run), the proxy and the direct-hole llm (forced-egress inputs), forwarded pi
args, and the seed inputs.

The key is a single opaque string the CLI stamps verbatim onto a netcage label
and matches on equality; its internal encoding is not a contract (only compare
keys produced by `keptContainerKey`).

## Consequences

- A `--rm` (throwaway) launch is always a fresh `run` and never consults the
  listing (it must never resume a kept container).
- The CLI (a later task) owns the impure half: run the netcage query, read the
  stamped key back off the `netcage.managed` label, and `netcage start <ref>`
  the match. The pure `resolveRunVsStart(intent, listing)` decision only reads
  the query's RESULT, so it stays unit-testable with fixture listings.
