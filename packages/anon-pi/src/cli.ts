#!/usr/bin/env node
// anon-pi CLI: the THIN impure launch path. Parses grammar A (pure
// parseLaunchArgs), reads config.json / machine.json + resolves the machine,
// composes the LaunchIntent, resolves the RunPlan (pure resolveRunPlan), decides
// run-vs-start against real netcage for `--keep`, and spawns netcage with
// inherited stdio (so -it is a real interactive TTY), propagating the exit code.
//
// All the DECISIONS live in the pure module (anon-pi.ts); this file only does
// I/O: fs reads/mkdirs, the netcage query, the spawn, and the TTY discipline.
// The forced-egress invariant is the RunPlan's guarantee: the composed argv
// ALWAYS carries --proxy + the one --allow-direct; the CLI never strips or adds
// egress.

import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import {readSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {
	AnonPiError,
	HELP,
	MODELS_FILE,
	SEED_MARKER,
	DEFAULT_MACHINE,
	envFromProcess,
	machineDir,
	machineHomeDir,
	machineJsonPath,
	resolveDeleteHome,
	resolveDeleteProject,
	parseConfigJson,
	parseLaunchArgs,
	parseMachineArgs,
	parseMachineJson,
	projectHostDir,
	resolveAnonPiHome,
	resolveLlm,
	resolveProjectsRoot,
	resolveProxy,
	resolveRunPlan,
	resolveRunVsStart,
	serializeMachineJson,
	setImageWarning,
	keptContainerKey,
	type AnonPiConfig,
	type AnonPiEnv,
	type KeptContainer,
	type LaunchIntent,
	type Machine,
	type MachineConfig,
	type MachineCommand,
	type ParsedLaunch,
} from './anon-pi.js';

// The netcage label anon-pi stamps its launch-identity key onto (keptContainerKey)
// so a `--keep` re-entry can find and `netcage start` the same kept container.
// netcage's `netcage.managed` label marks it a managed container; this adds the
// anon-pi identity ON TOP (netcage's label IS the registry; anon-pi adds no file).
const ANON_PI_KEY_LABEL = 'anon-pi.key';

function main(argv: string[]): number {
	const args = argv.slice(2);

	if (args.includes('--help') || args.includes('-h')) {
		process.stdout.write(HELP);
		return 0;
	}

	// `machine …` is the machine-management surface (create/list/set-image/rm),
	// dispatched BEFORE the launch grammar so a bare `machine` is never parsed as
	// a project named "machine". Everything else is a launch.
	if (args[0] === 'machine') {
		return runMachine(args.slice(1));
	}

	// The destructive cleanup verbs (replacing the old `--fresh`). Dispatched
	// BEFORE the launch grammar: they are top-level data verbs, not launch flags,
	// each with the confirm/`--yes`/non-TTY discipline. `--delete-home` takes an
	// OPTIONAL machine (default machine when omitted); `--delete-project` REQUIRES
	// a project.
	if (args[0] === '--delete-home') {
		return runDeleteHome(args.slice(1));
	}
	if (args[0] === '--delete-project') {
		return runDeleteProject(args.slice(1));
	}

	let parsed: ParsedLaunch;
	try {
		parsed = parseLaunchArgs(args);
	} catch (e) {
		return reportAnonPiError(e);
	}

	return runLaunch(parsed);
}

// --- the launch path --------------------------------------------------------
function runLaunch(parsed: ParsedLaunch): number {
	const env = envFromProcess(process.env);

	// config.json (the workspace default proxy/llm/defaultMachine/projects).
	const config = readJsonConfig(env);

	// Resolve the machine: an explicit -m wins, else config.defaultMachine, else
	// the built-in DEFAULT_MACHINE (so an explicit `-m default` is honoured too).
	const machineName = parsed.machineExplicit
		? parsed.machine
		: (config.defaultMachine ?? DEFAULT_MACHINE);

	const machineConf = readMachineJson(env, machineName);

	// Forced-egress inputs, resolved (env over config); the proxy is REQUIRED and
	// fails closed with the verbatim guidance.
	let proxy: string;
	let llm: string | undefined;
	let intent: LaunchIntent;
	try {
		proxy = resolveProxy({env, config});
		llm = resolveLlm({env, config});
		if (llm === undefined) {
			throw new AnonPiError(
				'anon-pi: set ANON_PI_LLM (or config.llm) to the RFC1918/link-local IP[:port]\n' +
					'of your local model. It is the ONE direct hole; all other egress stays\n' +
					'forced through the proxy.',
			);
		}

		// The machine's image: machine.json wins, ANON_PI_IMAGE is the fallback.
		const image = machineConf.image ?? env.image ?? '';

		// --mount re-roots at a HOST parent; otherwise the resolved projects root.
		const mountParent = parsed.mountParent;
		const projectsRoot = resolveProjectsRoot({
			env,
			config,
			machine: machineConf,
			mountParent,
		});

		const home = machineHomeDir(env, machineName);
		const machine: Machine = {name: machineName, home, image};

		// The generated models.json for this machine (mounted read-only for the
		// first-launch seed) when present. Keyed per machine, not per import.
		const modelsSeed = join(machineDir(env, machineName), MODELS_FILE);

		intent = {
			machine,
			mode: parsed.mode,
			projectsRoot,
			project: parsed.project,
			mountParent,
			piArgs: parsed.piArgs,
			keep: parsed.keep,
			proxy,
			llmDirect: llm,
			modelsSeed: existsSync(modelsSeed) ? modelsSeed : undefined,
		};
	} catch (e) {
		return reportAnonPiError(e);
	}

	// No-TTY discipline: the bare MENU and every INTERACTIVE launch (interactive
	// pi, or a shell) need a TTY; a HEADLESS pi run (`<project> <pi-args…>`) does
	// NOT. Check BEFORE we mutate anything or spawn.
	const headless =
		parsed.mode === 'pi' && !!parsed.piArgs && parsed.piArgs.length > 0;
	if (!headless && !process.stdin.isTTY) {
		if (parsed.mode === 'menu') {
			process.stderr.write(
				'anon-pi: no TTY. The menu needs an interactive terminal. Pick a project\n' +
					'directly, e.g. `anon-pi <project>`, or run anon-pi in a terminal.\n',
			);
		} else {
			process.stderr.write(
				`anon-pi: no TTY. An interactive ${parsed.mode === 'shell' ? 'shell' : 'pi session'} needs a terminal.\n` +
					'Forward a one-shot pi prompt instead, e.g. `anon-pi <project> -p "..."`.\n',
			);
		}
		return 1;
	}

	// Fail loud if netcage is not installed, before we mutate anything.
	if (!hasNetcage()) {
		process.stderr.write(
			'anon-pi: `netcage` not found on PATH. anon-pi is a launcher for netcage; install it first\n' +
				'(https://github.com/wighawag/netcage). Linux only.\n',
		);
		return 1;
	}

	// Resolve the RunPlan (pure). homeFresh reads the real seed marker.
	let plan;
	try {
		plan = resolveRunPlan(intent, homeFresh);
	} catch (e) {
		return reportAnonPiError(e);
	}

	// Bare launch: hand off to the interactive menu (the next task fills it in).
	if (plan.kind === 'menu') {
		return runMenu(intent, plan.machine);
	}

	// Create the host dirs the mounts need BEFORE spawn: the machine home and,
	// for a named project (not the root token `.` / a bare shell), its folder
	// under the active root (the --mount parent or the projects root).
	mkdirSync(plan.machine.home, {recursive: true});
	if (
		intent.project !== undefined &&
		intent.project !== '.' &&
		intent.mode !== 'shell'
	) {
		const root = intent.mountParent ?? intent.projectsRoot;
		mkdirSync(projectHostDir(root, intent.project), {recursive: true});
	} else {
		// still ensure the active root exists (so a shell/`.`/menu-picked launch
		// has a real dir to cwd into).
		mkdirSync(intent.mountParent ?? intent.projectsRoot, {recursive: true});
	}

	// Run-vs-start: under --keep, ask netcage for its kept managed containers and
	// resume a matching one via `netcage start`; else run the composed argv. A
	// throwaway (`--rm`) launch is always a fresh run (the pure rule never
	// consults the listing for it).
	if (intent.keep) {
		const decision = resolveRunVsStart(intent, queryKeptContainers());
		if (decision.action === 'start') {
			return spawnNetcage(['start', '-a', '-i', decision.ref]);
		}
		// A fresh `--keep` run: stamp the identity key so a later re-entry can
		// find this container. The RunPlan already omits --rm under --keep.
		return spawnNetcage(
			withKeyLabel(plan.netcageArgs, keptContainerKey(intent)),
		);
	}

	return spawnNetcage(plan.netcageArgs);
}

// --- the interactive menu hook (filled by cli-bare-launch-menu-tui) ----------
// Bare launch dispatches here. Until the TUI lands, tell the user how to launch
// directly so `<project>`/`--shell`/`-m`/`--mount` all work end-to-end now.
function runMenu(_intent: LaunchIntent, machine: Machine): number {
	process.stderr.write(
		`anon-pi: the interactive project menu for machine "${machine.name}" is not available yet.\n` +
			'Launch a project directly for now, e.g. `anon-pi <project>` (pi) or\n' +
			'`anon-pi --shell [<project>]` (a jailed shell). Run `anon-pi --help`.\n',
	);
	return 1;
}

// --- the `machine` verbs (thin dispatch over the pure parts) -----------------
//
// Parse the `machine <verb> …` grammar (pure parseMachineArgs), then do only the
// I/O: mkdir/write the machine layout (create), read machines/*/machine.json
// (list), rewrite machine.json + WARN (set-image), and rm the machine dir with
// the confirm/`--yes`/non-TTY discipline (rm). All validation + the machine.json
// body + the warning wording live in the pure module.
function runMachine(machineArgs: string[]): number {
	if (machineArgs.includes('--help') || machineArgs.includes('-h')) {
		process.stdout.write(MACHINE_HELP);
		return 0;
	}

	const env = envFromProcess(process.env);
	let cmd: MachineCommand;
	try {
		cmd = parseMachineArgs(machineArgs);
	} catch (e) {
		return reportAnonPiError(e);
	}

	try {
		switch (cmd.verb) {
			case 'create':
				return machineCreate(env, cmd.name, cmd.image);
			case 'list':
				return machineList(env);
			case 'set-image':
				return machineSetImage(env, cmd.name, cmd.image);
			case 'rm':
				return machineRm(env, cmd.name, cmd.yes);
		}
	} catch (e) {
		return reportAnonPiError(e);
	}
}

/**
 * `machine create <name> [--image <ref>]`: write machines/<name>/{machine.json,
 * home/} and PIN the image (from --image or a TTY prompt). The home is only a
 * dir here; it is SEEDED on first LAUNCH, not now. Refuses to clobber an
 * existing machine.
 */
function machineCreate(
	env: AnonPiEnv,
	name: string,
	image: string | undefined,
): number {
	const dir = machineDir(env, name);
	if (existsSync(dir)) {
		process.stderr.write(
			`anon-pi: machine ${JSON.stringify(name)} already exists (${dir}). ` +
				'Use `anon-pi machine set-image` to re-pin its image, or `anon-pi machine rm` first.\n',
		);
		return 1;
	}

	// Pin the image: --image wins; else prompt on a TTY; else it is an error (a
	// machine with no image cannot launch, so we refuse a headless imageless create).
	let pinned = image;
	if (pinned === undefined) {
		if (!process.stdin.isTTY) {
			process.stderr.write(
				'anon-pi: no image and no TTY to prompt. Pass `--image <ref>` to pin the ' +
					"machine's image (a container ref with `pi` on PATH).\n",
			);
			return 1;
		}
		pinned = promptLine(
			`Image ref for machine ${JSON.stringify(name)} (a container with \`pi\` on PATH): `,
		);
		if (pinned === undefined || pinned.trim() === '') {
			process.stderr.write('anon-pi: no image given; aborting create.\n');
			return 1;
		}
	}

	mkdirSync(machineHomeDir(env, name), {recursive: true});
	writeFileSync(
		machineJsonPath(env, name),
		serializeMachineJson({image: pinned}),
	);
	process.stdout.write(
		`anon-pi: created machine ${JSON.stringify(name)} (image ${pinned.trim()}) at ${dir}.\n` +
			`Its home is seeded on first launch, e.g. \`anon-pi -m ${name} --shell\`.\n`,
	);
	return 0;
}

/**
 * `machine list`: print each machine under machines/ with its pinned image
 * (reading each machine's machine.json). An absent/garbage machine.json shows
 * `(no image)` rather than erroring, so a hand-edited workspace still lists.
 */
function machineList(env: AnonPiEnv): number {
	const root = join(resolveAnonPiHome(env), 'machines');
	const names = existsSync(root)
		? readdirSync(root, {withFileTypes: true})
				.filter((d) => d.isDirectory())
				.map((d) => d.name)
				.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
		: [];
	if (names.length === 0) {
		process.stdout.write(
			'anon-pi: no machines yet. Create one with `anon-pi machine create <name> --image <ref>`.\n',
		);
		return 0;
	}
	for (const name of names) {
		const conf = readMachineJson(env, name);
		const image = conf.image ?? '(no image)';
		process.stdout.write(`${name}\t${image}\n`);
	}
	return 0;
}

/**
 * `machine set-image <name> <ref>`: RE-PIN the image and WARN only. It does NOT
 * reseed or touch the home (the home's extensions/bin were built for the OLD
 * image). Preserves any per-machine projects override. The machine must exist.
 */
function machineSetImage(env: AnonPiEnv, name: string, image: string): number {
	const dir = machineDir(env, name);
	if (!existsSync(dir)) {
		process.stderr.write(
			`anon-pi: no machine ${JSON.stringify(name)} (${dir}). ` +
				'Create it first with `anon-pi machine create`.\n',
		);
		return 1;
	}
	const prev = readMachineJson(env, name);
	writeFileSync(
		machineJsonPath(env, name),
		serializeMachineJson({image, projects: prev.projects}),
	);
	process.stderr.write(setImageWarning(name, prev.image, image.trim()) + '\n');
	return 0;
}

/**
 * `machine rm <name> [--yes]`: delete the machine dir (its machine.json + home)
 * after a confirm. Mirrors the destructive data-verb discipline: confirm on a
 * TTY, `--yes` skips it, and a non-TTY WITHOUT `--yes` ABORTS (never deletes
 * unprompted in a script). The machine must exist.
 */
function machineRm(env: AnonPiEnv, name: string, yes: boolean): number {
	const dir = machineDir(env, name);
	if (!existsSync(dir)) {
		process.stderr.write(
			`anon-pi: no machine ${JSON.stringify(name)} (${dir}); nothing to remove.\n`,
		);
		return 1;
	}

	if (!yes) {
		if (!process.stdin.isTTY) {
			process.stderr.write(
				`anon-pi: refusing to delete machine ${JSON.stringify(name)} without a TTY to confirm. ` +
					'Re-run with `--yes` to delete it (its home + conversations) non-interactively.\n',
			);
			return 1;
		}
		const answer = promptLine(
			`Delete machine ${JSON.stringify(name)} and its home (conversations, config) at ${dir}? [y/N] `,
		);
		if (answer === undefined || !/^y(es)?$/i.test(answer.trim())) {
			process.stderr.write('anon-pi: aborted; nothing deleted.\n');
			return 1;
		}
	}

	rmSync(dir, {recursive: true, force: true});
	process.stdout.write(
		`anon-pi: removed machine ${JSON.stringify(name)} (${dir}).\n`,
	);
	return 0;
}

// --- the destructive cleanup verbs (thin I/O over the pure resolvers) --------
//
// `--delete-home [<machine>]` and `--delete-project <project>` REPLACE the old
// `--fresh`. The pure module resolves the affected host paths (resolveDeleteHome
// / resolveDeleteProject); the CLI does ONLY the I/O: read config (for the
// default machine + the projects root), filter the resolved paths to those that
// exist, run the shared confirm/`--yes`/non-TTY discipline, then `rm`.

/**
 * Parse the shared `[<positional>] [--yes|-y]` tail of a data verb. Returns the
 * (optional) positional (a machine or project name) + the `--yes` flag, or an
 * AnonPiError-style exit for an unknown flag / an extra positional.
 */
function parseDeleteArgs(
	args: string[],
	verb: string,
): {name?: string; yes: boolean} | number {
	let name: string | undefined;
	let yes = false;
	for (const a of args) {
		if (a === '--yes' || a === '-y') {
			yes = true;
			continue;
		}
		if (a.startsWith('-')) {
			process.stderr.write(
				`anon-pi: unknown option for ${verb}: ${a}. Run \`anon-pi --help\`.\n`,
			);
			return 1;
		}
		if (name !== undefined) {
			process.stderr.write(
				`anon-pi: ${verb} takes one name, got extra: ${a}. Run \`anon-pi --help\`.\n`,
			);
			return 1;
		}
		name = a;
	}
	return {name, yes};
}

/**
 * Run the confirm/`--yes`/non-TTY discipline for a destructive delete: `--yes`
 * skips the prompt; a non-TTY WITHOUT `--yes` ABORTS (never deletes unprompted
 * in a script); a TTY prompts `[y/N]`. Returns true to PROCEED, false to abort
 * (the caller has already printed nothing; this prints the abort/refusal note).
 */
function confirmDelete(what: string, yes: boolean): boolean {
	if (yes) return true;
	if (!process.stdin.isTTY) {
		process.stderr.write(
			`anon-pi: refusing to delete ${what} without a TTY to confirm. ` +
				'Re-run with `--yes` to delete it non-interactively.\n',
		);
		return false;
	}
	const answer = promptLine(`Delete ${what}? [y/N] `);
	if (answer === undefined || !/^y(es)?$/i.test(answer.trim())) {
		process.stderr.write('anon-pi: aborted; nothing deleted.\n');
		return false;
	}
	return true;
}

/**
 * `--delete-home [<machine>]`: delete ONE machine's HOME (config + convos + shell
 * env), keeping its machine.json image pin (so it can be relaunched to reseed a
 * fresh home) and ALL project files (they live under the projects root). Default
 * machine (config.defaultMachine, else the built-in DEFAULT_MACHINE) when the
 * name is omitted. Confirm / `--yes` / non-TTY abort.
 */
function runDeleteHome(args: string[]): number {
	if (args.includes('--help') || args.includes('-h')) {
		process.stdout.write(HELP);
		return 0;
	}
	const env = envFromProcess(process.env);
	const parsed = parseDeleteArgs(args, '--delete-home');
	if (typeof parsed === 'number') return parsed;

	const config = readJsonConfig(env);
	const machine = parsed.name ?? config.defaultMachine ?? DEFAULT_MACHINE;

	let plan;
	try {
		plan = resolveDeleteHome(env, machine);
	} catch (e) {
		return reportAnonPiError(e);
	}

	if (!existsSync(plan.home)) {
		process.stderr.write(
			`anon-pi: no home for machine ${JSON.stringify(plan.machine)} (${plan.home}); nothing to delete.\n`,
		);
		return 1;
	}

	if (
		!confirmDelete(
			`machine ${JSON.stringify(plan.machine)} home (conversations + config) at ${plan.home}`,
			parsed.yes,
		)
	) {
		return 1;
	}

	rmSync(plan.home, {recursive: true, force: true});
	process.stdout.write(
		`anon-pi: deleted machine ${JSON.stringify(plan.machine)} home (${plan.home}). ` +
			'Its image pin is kept; relaunch to seed a fresh home.\n',
	);
	return 0;
}

/**
 * `--delete-project <project>`: delete the project's FILES (its folder under the
 * resolved projects root) AND that project's per-machine session dir in EVERY
 * machine home (the machine-invariant slug), keeping the homes otherwise intact.
 * Confirm / `--yes` / non-TTY abort. The project name is REQUIRED.
 */
function runDeleteProject(args: string[]): number {
	if (args.includes('--help') || args.includes('-h')) {
		process.stdout.write(HELP);
		return 0;
	}
	const env = envFromProcess(process.env);
	const parsed = parseDeleteArgs(args, '--delete-project');
	if (typeof parsed === 'number') return parsed;
	if (parsed.name === undefined) {
		process.stderr.write(
			'anon-pi: --delete-project needs a <project>. Run `anon-pi --help`.\n',
		);
		return 1;
	}

	const config = readJsonConfig(env);
	// The RESOLVED projects root (config/env override, else the built-in). No
	// --mount here: a data verb targets the durable projects root, not a per-run
	// host parent.
	const projectsRoot = resolveProjectsRoot({env, config});
	const machines = listMachineNames(env);

	let plan;
	try {
		plan = resolveDeleteProject({
			env,
			project: parsed.name,
			projectsRoot,
			machines,
		});
	} catch (e) {
		return reportAnonPiError(e);
	}

	// Only the paths that actually exist: the folder (maybe absent) + whichever
	// machine homes hold this project's session dir.
	const targets = [plan.folder, ...plan.sessions].filter((p) => existsSync(p));
	if (targets.length === 0) {
		process.stderr.write(
			`anon-pi: no files or sessions found for project ${JSON.stringify(plan.project)} ` +
				`(looked in ${plan.folder} and each machine home); nothing to delete.\n`,
		);
		return 1;
	}

	const sessionCount = targets.length - (existsSync(plan.folder) ? 1 : 0);
	if (
		!confirmDelete(
			`project ${JSON.stringify(plan.project)}: its files (${plan.folder}) ` +
				`and ${sessionCount} per-machine session dir(s)`,
			parsed.yes,
		)
	) {
		return 1;
	}

	for (const p of targets) rmSync(p, {recursive: true, force: true});
	process.stdout.write(
		`anon-pi: deleted project ${JSON.stringify(plan.project)} ` +
			`(files + ${sessionCount} per-machine session dir(s)). The machine homes are kept.\n`,
	);
	return 0;
}

/** List machine names (readdir of machines/), or [] if the dir is absent. */
function listMachineNames(env: AnonPiEnv): string[] {
	const root = join(resolveAnonPiHome(env), 'machines');
	if (!existsSync(root)) return [];
	return readdirSync(root, {withFileTypes: true})
		.filter((d) => d.isDirectory())
		.map((d) => d.name);
}

/**
 * Read one line from stdin synchronously for a confirm/value prompt, writing the
 * prompt to stderr first. Returns undefined on EOF/error. Only called on a TTY
 * (the verbs enforce the non-TTY discipline before prompting), so a blocking
 * byte-at-a-time read from fd 0 is fine: the user types a line and hits enter.
 */
function promptLine(prompt: string): string | undefined {
	process.stderr.write(prompt);
	const byte = Buffer.alloc(1);
	let line = '';
	for (;;) {
		let n: number;
		try {
			n = readSync(0, byte, 0, 1, null);
		} catch (e) {
			// EAGAIN on a non-blocking TTY: retry; anything else ends the read.
			if ((e as NodeJS.ErrnoException).code === 'EAGAIN') continue;
			break;
		}
		if (n === 0) break; // EOF
		const ch = byte.toString('utf8', 0, 1);
		if (ch === '\n') return line;
		if (ch !== '\r') line += ch;
	}
	return line === '' ? undefined : line;
}

/** The `machine` subcommand help. */
const MACHINE_HELP = `anon-pi machine - manage machines (an image + a persistent host home)

USAGE
  anon-pi machine create <name> [--image <ref>]   create a machine, pin its image
  anon-pi machine list                            list machines and their images
  anon-pi machine set-image <name> <ref>          re-pin the image (WARNS; no reseed)
  anon-pi machine rm <name> [--yes]               delete the machine + its home

A machine is an image + a persistent host home (machines/<name>/{machine.json,home/}).
The home is seeded on FIRST LAUNCH, not at create. \`set-image\` re-pins only and
warns (the home was built for the old image); \`rm\` confirms on a TTY, skips with
\`--yes\`, and aborts non-interactively without it.
`;

// --- impure helpers ---------------------------------------------------------

/** Read + parse <anon-pi-home>/config.json (tolerant: absent/garbage => {}). */
function readJsonConfig(env: AnonPiEnv): AnonPiConfig {
	const path = join(resolveAnonPiHome(env), 'config.json');
	return parseConfigJson(readJsonFile(path));
}

/** Read + parse a machine's machine.json (tolerant: absent/garbage => {}). */
function readMachineJson(env: AnonPiEnv, name: string): MachineConfig {
	return parseMachineJson(readJsonFile(machineJsonPath(env, name)));
}

/** Read + JSON.parse a file, returning undefined if absent or unparseable. */
function readJsonFile(path: string): unknown {
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, 'utf8'));
	} catch {
		return undefined;
	}
}

/**
 * True iff a machine home is FRESH (no seed marker): the seed will run. The
 * marker lives under the mounted home at `.pi/agent/<SEED_MARKER>` (the host
 * side of the container's /root/.pi/agent = CONTAINER_AGENT_DIR).
 */
function homeFresh(machineHome: string): boolean {
	const marker = join(machineHome, '.pi', 'agent', SEED_MARKER);
	return !existsSync(marker);
}

/**
 * Query netcage for its KEPT managed containers, surfacing each one's stamped
 * anon-pi identity key so the pure run-vs-start decision can match it. Thin,
 * best-effort I/O: on any failure (netcage missing the query, no containers, a
 * parse error) it returns an EMPTY listing, so the decision falls back to a
 * fresh `run` (safe: it never wrongly resumes, it just creates a new container).
 */
function queryKeptContainers(): KeptContainer[] {
	// Ask netcage for its managed containers as JSON, reading back the anon-pi
	// key label. netcage is a podman drop-in, so `ps` accepts the same
	// label-filter + Go-template/JSON format flags.
	const res = spawnSync(
		'netcage',
		[
			'ps',
			'-a',
			'--filter',
			'label=netcage.managed',
			'--format',
			'{{.ID}}\t{{.Labels}}',
		],
		{encoding: 'utf8'},
	);
	if (res.error || res.status !== 0 || !res.stdout) return [];

	const out: KeptContainer[] = [];
	for (const line of res.stdout.split('\n')) {
		const trimmed = line.trim();
		if (trimmed === '') continue;
		const tab = trimmed.indexOf('\t');
		if (tab < 0) continue;
		const ref = trimmed.slice(0, tab).trim();
		const labels = trimmed.slice(tab + 1);
		const key = extractKeyLabel(labels);
		if (ref !== '' && key !== undefined) out.push({key, ref});
	}
	return out;
}

/**
 * Pull the anon-pi key out of a podman `{{.Labels}}` rendering (a
 * comma-separated `k=v` list). The key is stamped as `anon-pi.key=<opaque>`;
 * because keptContainerKey embeds newlines, the CLI base64-encodes it when
 * stamping (withKeyLabel) and decodes it here, so a `\n` never breaks the label.
 */
function extractKeyLabel(labels: string): string | undefined {
	for (const pair of labels.split(',')) {
		const eq = pair.indexOf('=');
		if (eq < 0) continue;
		const k = pair.slice(0, eq).trim();
		if (k !== ANON_PI_KEY_LABEL) continue;
		const v = pair.slice(eq + 1).trim();
		try {
			return Buffer.from(v, 'base64').toString('utf8');
		} catch {
			return undefined;
		}
	}
	return undefined;
}

/**
 * Insert the anon-pi identity label into a `netcage run` argv (right after
 * `run`), so a kept container can be found on re-entry. The key is base64'd
 * (keptContainerKey embeds newlines) to keep it a single safe label value. This
 * is ADDITIVE and touches NO egress flag (the RunPlan owns --proxy/--allow-direct).
 */
function withKeyLabel(netcageArgs: string[], key: string): string[] {
	const enc = Buffer.from(key, 'utf8').toString('base64');
	const out = netcageArgs.slice();
	// netcageArgs[0] is 'run'; splice the label right after it.
	out.splice(1, 0, '--label', `${ANON_PI_KEY_LABEL}=${enc}`);
	return out;
}

/** Spawn netcage with inherited stdio; propagate its exit code. */
function spawnNetcage(netcageArgs: string[]): number {
	const res = spawnSync('netcage', netcageArgs, {stdio: 'inherit'});
	if (res.error) {
		process.stderr.write(
			`anon-pi: failed to run netcage: ${res.error.message}\n`,
		);
		return 1;
	}
	return res.status ?? 1;
}

function hasNetcage(): boolean {
	const which = spawnSync(
		process.platform === 'win32' ? 'where' : 'command',
		['-v', 'netcage'],
		{
			stdio: 'ignore',
			shell: process.platform !== 'win32',
		},
	);
	if (which.status === 0) return true;
	// Fallback: try running it harmlessly.
	const probe = spawnSync('netcage', ['--help'], {stdio: 'ignore'});
	return !probe.error;
}

/** Print an AnonPiError's message verbatim (exit 1) or rethrow anything else. */
function reportAnonPiError(e: unknown): number {
	if (e instanceof AnonPiError) {
		process.stderr.write(e.message + '\n');
		return 1;
	}
	throw e;
}

process.exit(main(process.argv));
