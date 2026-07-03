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

import {existsSync, mkdirSync, readFileSync} from 'node:fs';
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
	parseConfigJson,
	parseLaunchArgs,
	parseMachineJson,
	projectHostDir,
	resolveAnonPiHome,
	resolveLlm,
	resolveProjectsRoot,
	resolveProxy,
	resolveRunPlan,
	resolveRunVsStart,
	keptContainerKey,
	type AnonPiConfig,
	type AnonPiEnv,
	type KeptContainer,
	type LaunchIntent,
	type Machine,
	type MachineConfig,
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
