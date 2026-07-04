---
'anon-pi': minor
---

Add the `anon-pi machine {create,list,set-image,rm}` verbs to `src/cli.ts`,
making machines first-class (an image + a persistent host home,
`machines/<name>/{machine.json,home/}`). Dispatch stays thin; the parse,
validation, machine.json serialisation, and the set-image warning wording live
in the pure module (`src/anon-pi.ts`).

- **`machine create <name> [--image <ref>]`**: validates the name (reserved-name
  / traversal guard via `validateName`), writes `machines/<name>/machine.json` +
  `home/`, and pins the image (from `--image`, else a TTY prompt; a non-TTY
  create without `--image` aborts). The home is a dir only here; it is SEEDED on
  first LAUNCH, not at create. Refuses to clobber an existing machine.
- **`machine list`**: prints each machine and its pinned image (reads each
  machine's `machine.json`; a missing image shows `(no image)`). An empty
  workspace reports so clearly.
- **`machine set-image <name> <ref>`**: RE-PINS the image and prints a
  compatibility WARNING only. It does NOT reseed or touch the home (the home's
  extensions / downloaded tools were built for the OLD image); the warning names
  the two remedies (`pi install` inside the machine, or `--delete-home` to
  reseed). Preserves a per-machine `projects` override across the re-pin.
- **`machine rm <name> [--yes]`**: deletes the machine dir (its `machine.json` +
  home) after a confirm, mirroring the destructive-verb discipline: confirm on a
  TTY, `--yes` / `-y` skips it, and a non-TTY WITHOUT `--yes` ABORTS (never
  deletes unprompted in a script).

New pure exports: `parseMachineArgs` (the `machine <verb> …` grammar ->
`MachineCommand`), `serializeMachineJson`, and `setImageWarning`. The `machine`
subcommand is dispatched before the launch grammar, so `machine` is never parsed
as a project name.
