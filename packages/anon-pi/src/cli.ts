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
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import {readSync} from 'node:fs';
import {spawnSync, execFileSync} from 'node:child_process';
import {join, dirname, resolve} from 'node:path';
import {
	AnonPiError,
	HELP,
	MODELS_FILE,
	SETTINGS_FILE,
	SETTINGS_SEED_FILE,
	SEED_MARKER,
	DEFAULT_MACHINE,
	envFromProcess,
	buildMenuChoiceList,
	buildMenuEntries,
	builtinProjectsRoot,
	deriveProjectUsage,
	expandTilde,
	findingsFromNetcageDetect,
	processNoteFromNetcageDetect,
	resolveNetcageGraphroot,
	globalModelsSeedPath,
	globalSettingsSeedPath,
	machineAgentDir,
	machineDir,
	machineHomeDir,
	machineJsonPath,
	machineModelsSeedPath,
	machineSessionsDir,
	mergeModelSelection,
	resolveModelsSeedPath,
	resolveSettingsSeedPath,
	validateName,
	resolveDeleteHome,
	resolveDeleteProject,
	parseConfigJson,
	parseLaunchArgs,
	parseForwardArgs,
	parsePortsArgs,
	parsePortArg,
	parseKeptKey,
	keyProject,
	resolveManagedMatches,
	parseNetcagePsJson,
	parseNetcagePortsJson,
	forwardablePorts,
	formatPortsHint,
	isHeadlessPiArgs,
	resumeSessionId,
	sessionHeaderCwd,
	anonPiVersion,
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
	snapshotImageRef,
	snapshotSessionGroups,
	copyIncludesForHomeMinusSessions,
	type SnapshotSessionGroup,
	serializeConfigJson,
	setImageWarning,
	keptContainerKey,
	DEFAULT_SOCKS_PROBE_PORTS,
	SOCKS5_METHOD_SELECTOR,
	formatProxyFindings,
	interpretSocks5Handshake,
	initImageMenu,
	generateModelsJson,
	generateModelSelection,
	pickLocalProviderModels,
	parseModelsListing,
	mergeModelSources,
	resolveHostModelsPath,
	LOCAL_PROVIDER_API_KEY,
	parseVerifyExitIp,
	processHint,
	socks5hUrl,
	hostPortKey,
	shippedDockerfilePath,
	shippedWebveilDockerfilePath,
	type MenuEntry,
	type SessionDirListing,
	type ProxyFinding,
	type NetcageDetectProxy,
	type SocksHandshake,
	type InitImageChoice,
	type AnonPiConfig,
	type AnonPiEnv,
	type GeneratedModel,
	type ModelCandidate,
	type ModelSelection,
	type KeptContainer,
	type ManagedContainer,
	type NetcageListener,
	type LaunchIntent,
	type Machine,
	type MachineConfig,
	type MachineCommand,
	type ParsedLaunch,
	type PiModelsFile,
} from './anon-pi.js';

// The netcage label anon-pi stamps its launch-identity key onto (keptContainerKey)
// so a `--keep` re-entry can find and `netcage start` the same kept container.
// netcage's `netcage.managed` label marks it a managed container; this adds the
// anon-pi identity ON TOP (netcage's label IS the registry; anon-pi adds no file).
const ANON_PI_KEY_LABEL = 'anon-pi.key';

function main(argv: string[]): number {
	const args = argv.slice(2);

	// `--version`/`-V` prints anon-pi's own version and exits (before the launch
	// grammar, so it is never parsed as a project/flag). For pi's version inside
	// the jail, forward it: `anon-pi pi --version`.
	if (args[0] === '--version' || args[0] === '-V') {
		process.stdout.write(`anon-pi ${anonPiVersion() ?? '(unknown)'}\n`);
		return 0;
	}

	// The global `--help`/`-h` prints the top-level HELP, EXCEPT when the first
	// token is a subcommand that owns its own `--help` (so `anon-pi init --help`
	// and `anon-pi machine --help` show THEIR help, not the global one). Those
	// subcommands route to runInit / runMachine, which print INIT_HELP /
	// MACHINE_HELP respectively.
	const OWN_HELP_SUBCOMMANDS = new Set(['init', 'machine', 'forward', 'ports']);
	if (
		(args.includes('--help') || args.includes('-h')) &&
		!OWN_HELP_SUBCOMMANDS.has(args[0] ?? '')
	) {
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

	// `init` onboards: verify the proxy, capture the llm endpoint, pick/build the
	// default machine image, write config.json + the default machine. Re-runnable.
	if (args[0] === 'init') {
		return runInit(args.slice(1));
	}

	// Host-access verbs (netcage >= 0.10.0). `forward` opens a host->jail port; the
	// `ports` sibling lists a jail's open listeners. Dispatched BEFORE the launch
	// grammar so `forward`/`ports` are never parsed as a project name.
	if (args[0] === 'forward') {
		return runForward(args.slice(1));
	}
	if (args[0] === 'ports') {
		return runPorts(args.slice(1));
	}

	let parsed: ParsedLaunch;
	try {
		parsed = parseLaunchArgs(args);
	} catch (e) {
		return reportAnonPiError(e);
	}

	// FIRST RUN: no config.json yet. Rather than fail deep in the launch with the
	// bare "set ANON_PI_PROXY" wall (which reads like a doc dump the first time),
	// welcome the user and run `init` automatically, then continue into the
	// launch they asked for. Needs a TTY (init is interactive); without one we
	// fall through to the launch path, whose fail-closed proxy error is the right
	// signal for a script. An explicit ANON_PI_PROXY/ANON_PI_LLM env pair also
	// skips this (the user is driving config via env, not the file).
	if (isFirstRun()) {
		const code = runFirstRunInit();
		if (code !== 0) return code; // init aborted / failed: do not launch.
	}

	return runLaunch(parsed);
}

/**
 * First run = no config.json in the anon-pi home AND the user has not supplied
 * the forced-egress inputs via env (ANON_PI_PROXY is what the launch fails
 * closed on; if it is set the user is configuring via env and we do not
 * onboard). We only auto-onboard on an interactive terminal.
 */
function isFirstRun(): boolean {
	const env = envFromProcess(process.env);
	if (nonEmptyEnv(env.proxy)) return false; // env-driven config; no onboarding.
	if (!process.stdin.isTTY) return false; // scripts get the fail-closed error.
	const configPath = join(resolveAnonPiHome(env), 'config.json');
	return !existsSync(configPath);
}

/** Show a first-time welcome, then run `init`. Returns init's exit code. */
function runFirstRunInit(): number {
	process.stdout.write(
		'\n' +
			"Welcome to anon-pi. It looks like this is your first run (there's no\n" +
			'config yet), so let us set things up before launching.\n' +
			'\n' +
			'anon-pi runs pi on anonymized, jailed MACHINES: all of pi\u2019s web/DNS egress\n' +
			'is forced through your socks5h proxy (fail-closed), with ONE direct hole to\n' +
			'a local model. Your machines + conversations live in ~/.anon-pi/.\n' +
			'\n' +
			'Running `anon-pi init` now (re-runnable any time; nothing is destroyed).\n' +
			'\n',
	);
	return runInit([]);
}

/** Whether an env value is present + non-blank. */
function nonEmptyEnv(v: string | undefined): boolean {
	return typeof v === 'string' && v.trim() !== '';
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
		// Expand a leading `~` + absolutize the mount path so it is a real host dir
		// everywhere it is used (the mount, the mkdir, the intent). path.resolve
		// alone would leave `~/x` as a literal `~` dir.
		const mountParent =
			parsed.mountParent !== undefined
				? resolve(expandTilde(parsed.mountParent, env.home))
				: undefined;
		const projectsRoot = resolveProjectsRoot({
			env,
			config,
			machine: machineConf,
			mountParent,
		});

		const home = machineHomeDir(env, machineName);
		const machine: Machine = {name: machineName, home, image};

		// The local-model models.json + settings seed for this machine's FRESH-home
		// promotion. GLOBAL by default (<home>/models.json, shared across every
		// machine because the `llm` endpoint is global), with an optional
		// per-machine override (machines/<M>/models.json). Mounted read-only.
		const modelsSeed = resolveModelsSeedPath(env, machineName, existsSync);
		const settingsSeed = resolveSettingsSeedPath(env, machineName, existsSync);

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
			modelsSeed,
			settingsSeed,
		};

		// RESUME family with NO project: resolve the session's recorded cwd from the
		// host store and cd there, so pi resumes in place (no fork prompt). A given
		// project is trusted verbatim (pi guards a mismatch); an unresolvable id
		// leaves the cwd at the projects root (pi decides), so this is pure upside.
		if (parsed.mode === 'pi' && parsed.project === undefined) {
			const sessionCwd = resolveSessionCwd(env, machineName, parsed.piArgs);
			if (sessionCwd !== undefined) intent.sessionCwd = sessionCwd;
		}
	} catch (e) {
		return reportAnonPiError(e);
	}

	// No-TTY discipline: the bare MENU and every INTERACTIVE launch (interactive
	// pi, or a shell) need a TTY; only a HEADLESS pi run (forwarded `-p`/`--print`)
	// does NOT. Forwarded args that stay interactive (e.g. `--session <id>`,
	// `--model x`) still require a TTY. Check BEFORE we mutate anything or spawn.
	const headless = parsed.mode === 'pi' && isHeadlessPiArgs(parsed.piArgs);
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

	// Bare launch: hand off to the interactive host-side menu, which re-resolves
	// the user's pick into a concrete launch and executes it.
	if (plan.kind === 'menu') {
		return runMenu(intent, plan.machine);
	}

	return executeLaunchPlan(intent, plan);
}

/**
 * Execute a RESOLVED non-menu LaunchPlan: create the host dirs the mounts need,
 * then run netcage (or `netcage start` a matching kept container under --keep).
 * Shared by the direct launch path (runLaunch) and the menu dispatch (runMenu),
 * so a menu-picked project/here/shell launches BYTE-FOR-BYTE identically to the
 * same command typed directly.
 */
function executeLaunchPlan(
	intent: LaunchIntent,
	plan: Extract<ReturnType<typeof resolveRunPlan>, {kind: 'launch'}>,
): number {
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

	// The anon-pi identity key, stamped on EVERY launch (not just --keep) as an
	// additive netcage label. Under --keep it lets a re-entry find + `netcage
	// start` the kept container; on a throwaway --rm run it lets `anon-pi forward`
	// find the RUNNING container while it is up (the label goes away with the
	// container on exit). It touches NO egress flag (the RunPlan owns those).
	const keyed = withKeyLabel(plan.netcageArgs, keptContainerKey(intent));

	// Run-vs-start: under --keep, ask netcage for its kept managed containers and
	// resume a matching one via `netcage start`; else run the composed argv. A
	// throwaway (`--rm`) launch is always a fresh run (the pure rule never
	// consults the listing for it).
	if (intent.keep) {
		const decision = resolveRunVsStart(intent, queryKeptContainers());
		if (decision.action === 'start') {
			return spawnNetcage(['start', '-a', '-i', decision.ref], {
				enteringJail: true,
			});
		}
		// A fresh `--keep` run: the RunPlan already omits --rm so it is left kept.
		return spawnNetcage(keyed, {enteringJail: true});
	}

	return spawnNetcage(keyed, {enteringJail: true});
}

// --- the interactive host-side menu (the ONLY untested I/O) -------------------
//
// Bare `anon-pi` (and bare `-m <machine>` / `--mount <parent>` with no project)
// dispatches here. The menu is a PURE host-side read: it lists the active root's
// projects (readdir) + each machine's pi session dirs (readdir) and feeds them
// to the pure buildMenuChoiceList / deriveProjectUsage / buildMenuEntries, which
// own ALL the logic (the entry order + the used-on / new-here annotation). This
// function does ONLY the I/O the pure seam cannot: the real dir reads, the raw-
// mode arrow-key render/select (select()), the new-project name prompt, and the
// dispatch of the pick back through resolveRunPlan + executeLaunchPlan (so a
// menu pick launches identically to the same command typed directly). No jail
// runs until the user chooses; the no-TTY case is handled BEFORE we reach here
// (runLaunch's discipline), so a TTY is guaranteed.
function runMenu(intent: LaunchIntent, machine: Machine): number {
	const env = envFromProcess(process.env);

	// The active root the menu lists projects from: a --mount parent re-roots, else
	// the resolved projects root. (Named projects live under it; `.` is the root.)
	const root = intent.mountParent ?? intent.projectsRoot;
	const rawProjects = readDirNames(root);
	const choiceList = buildMenuChoiceList({projects: rawProjects});

	// Per-machine usage: the session-slug set present in each machine home's pi
	// sessions dir, machine-invariant, so a shared project is credited on each.
	const sessions: SessionDirListing = {};
	for (const name of listMachineNames(env)) {
		sessions[name] = readDirNames(machineSessionsDir(env, name));
	}
	// The current machine may be brand-new (no sessions dir yet); an absent entry
	// reads as "new for it" in deriveProjectUsage.
	if (sessions[machine.name] === undefined) sessions[machine.name] = [];
	const usage = deriveProjectUsage({
		projects: choiceList.projects,
		currentMachine: machine.name,
		sessions,
	});

	const entries = buildMenuEntries({choiceList, usage});

	const picked = select(entries, {
		header: `anon-pi: machine "${machine.name}" (\u2191/\u2193 move, Enter select, Ctrl-C quit)`,
	});
	if (picked === undefined) {
		// Ctrl-C / EOF: a clean quit, nothing launched (the terminal is restored).
		process.stderr.write('anon-pi: cancelled; nothing launched.\n');
		return 130; // 128 + SIGINT, the conventional Ctrl-C exit code.
	}

	// Turn the pick into a concrete launch intent, then re-resolve + execute it
	// EXACTLY as the equivalent direct command would (same resolveRunPlan path).
	let launchIntent: LaunchIntent;
	switch (picked.kind) {
		case 'project':
		case 'here':
			launchIntent = {...intent, mode: 'pi', project: picked.project};
			break;
		case 'shell':
			launchIntent = {...intent, mode: 'shell', project: undefined};
			break;
		case 'new': {
			const name = promptNewProject();
			if (name === undefined) return 1;
			launchIntent = {...intent, mode: 'pi', project: name};
			break;
		}
	}

	let plan;
	try {
		plan = resolveRunPlan(launchIntent, homeFresh);
	} catch (e) {
		return reportAnonPiError(e);
	}
	// A menu pick is always a concrete launch (never the menu marker again).
	if (plan.kind !== 'launch') {
		process.stderr.write('anon-pi: internal error resolving the menu pick.\n');
		return 1;
	}
	return executeLaunchPlan(launchIntent, plan);
}

/**
 * Prompt for a NEW project name and validate it (validateName, the same guard a
 * direct `anon-pi <name>` uses), so a menu-created project is a safe single
 * folder segment. Returns the validated name, or undefined on an empty entry /
 * EOF / a rejected name (with the error printed). TTY is guaranteed here.
 */
function promptNewProject(): string | undefined {
	const ans = promptLine('New project name (a single folder segment): ');
	if (ans === undefined || ans.trim() === '') {
		process.stderr.write('anon-pi: no name given; nothing launched.\n');
		return undefined;
	}
	try {
		return validateName(ans.trim(), 'project');
	} catch (e) {
		reportAnonPiError(e);
		return undefined;
	}
}

/**
 * Read the entry NAMES of a directory (best-effort): the plain names of its
 * direct children, or [] if the dir is absent / unreadable. Used for both the
 * projects-root listing (pure buildMenuChoiceList filters it to folder-safe
 * project names) and each machine's sessions dir (the session slugs present).
 */
function readDirNames(dir: string): string[] {
	if (!existsSync(dir)) return [];
	try {
		return readdirSync(dir, {withFileTypes: true}).map((d) => d.name);
	} catch {
		return [];
	}
}

// --- the hand-rolled, zero-dependency raw-mode selector ----------------------
//
// A small supply-chain surface is on-brand for a security tool and the project
// list is short, so instead of a prompt library we drive stdin in raw mode
// ourselves: up/down (arrows or k/j) move a `>` cursor, Enter selects, Ctrl-C /
// q / Esc cancels. The active row is highlighted (reverse video). The terminal
// is ALWAYS restored (raw mode off, cursor shown) on every exit path, including
// Ctrl-C. Isolated here behind a tiny signature so a well-regarded prompt lib
// could swap in later as a localized change. This is the ONLY untested I/O in
// the menu; all logic (entries + labels) is the pure buildMenuEntries.

const ESC = '\u001b';

/**
 * Present `entries` as an arrow-key list and return the chosen one, or undefined
 * on cancel (Ctrl-C / q / Esc / EOF). Blocks on raw stdin; restores the terminal
 * on every path. An empty entry list returns undefined immediately (nothing to
 * pick), though the menu always offers at least the `.` here entry.
 */
function select(
	entries: readonly MenuEntry[],
	opts: {header?: string} = {},
): MenuEntry | undefined {
	if (entries.length === 0) return undefined;
	const out = process.stdout;
	const stdin = process.stdin;
	let active = 0;

	const render = (first: boolean): void => {
		if (!first) {
			// move cursor up over the previously drawn rows to redraw in place.
			out.write(`${ESC}[${entries.length}A`);
		}
		for (let i = 0; i < entries.length; i++) {
			const selected = i === active;
			const cursor = selected ? '>' : ' ';
			const text = `${cursor} ${entries[i].label}`;
			// clear the line, then draw; reverse-video the active row.
			out.write(`${ESC}[2K`);
			out.write(selected ? `${ESC}[7m${text}${ESC}[0m` : text);
			out.write('\n');
		}
	};

	const wasRaw = stdin.isRaw ?? false;
	const restore = (): void => {
		try {
			if (stdin.setRawMode) stdin.setRawMode(wasRaw);
		} catch {
			/* best-effort */
		}
		out.write(`${ESC}[?25h`); // show the cursor again
	};

	if (opts.header) out.write(opts.header + '\n');
	out.write(`${ESC}[?25l`); // hide the cursor while navigating
	try {
		if (stdin.setRawMode) stdin.setRawMode(true);
	} catch {
		/* if raw mode is unavailable we still render + read line-ish below */
	}
	render(true);

	const buf = Buffer.alloc(3);
	for (;;) {
		let n: number;
		try {
			n = readSync(0, buf, 0, 3, null);
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === 'EAGAIN') continue;
			restore();
			return undefined;
		}
		if (n === 0) {
			restore();
			return undefined; // EOF
		}
		const s = buf.toString('utf8', 0, n);
		// Ctrl-C (ETX \x03), q, or a bare Esc: cancel.
		if (s === '\u0003' || s === 'q' || s === ESC) {
			restore();
			return undefined;
		}
		// Enter (CR or LF): select the active row.
		if (s === '\r' || s === '\n') {
			restore();
			return entries[active];
		}
		// Up: arrow `Esc [ A` / `Esc O A`, or k. Down: `Esc [ B` / `Esc O B`, or j.
		if (s === `${ESC}[A` || s === `${ESC}OA` || s === 'k') {
			active = (active - 1 + entries.length) % entries.length;
			render(false);
			continue;
		}
		if (s === `${ESC}[B` || s === `${ESC}OB` || s === 'j') {
			active = (active + 1) % entries.length;
			render(false);
			continue;
		}
		// any other key: ignore, keep waiting.
	}
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
			case 'snapshot':
				return machineSnapshot(env, cmd.name, cmd.machine, cmd.imageTag);
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

/**
 * `machine snapshot <new-name> [-m <machine>] [--image-tag <ref>]`: commit a
 * RUNNING jailed container into a new image and create <new-name> pinned to it.
 * The user does interactive system work in a session (e.g. `sudo apt install`),
 * then, WITHOUT having exited (the default `--rm` would have destroyed the
 * container), preserves that exact environment as a new machine. The container
 * to commit is AUTO-DETECTED from the running anon-pi containers (a picker when
 * several are up); `-m <machine>` is an OPTIONAL filter, not a required source.
 * podman pauses the container during commit and unpauses, so the live session
 * survives. The new machine gets a FRESH home (image and home are orthogonal;
 * snapshot keeps the SOFTWARE, not the conversations). Forced egress is
 * untouched: commit is a local podman op, and the snapshot machine relaunches
 * through the same forced-egress jail.
 */
function machineSnapshot(
	env: AnonPiEnv,
	name: string,
	machine: string | undefined,
	imageTag: string | undefined,
): number {
	// Refuse to clobber an existing target machine FIRST (before netcage / any
	// commit), so a name clash fails fast and never leaves an orphan image.
	// Mirrors machine create.
	const targetDir = machineDir(env, name);
	if (existsSync(targetDir)) {
		process.stderr.write(
			`anon-pi: machine ${JSON.stringify(name)} already exists (${targetDir}). ` +
				'Pick a different <new-name> or `anon-pi machine rm` it first.\n',
		);
		return 1;
	}

	if (!hasNetcage()) return netcageMissing();

	// Auto-detect the running anon-pi container to commit (optionally filtered by
	// -m <machine>); reuses the forward/ports running-container resolution.
	const target = resolveRunningContainer(machine, 'snapshot');
	if (target === undefined) return 1;

	const imageRef = imageTag ?? snapshotImageRef(name, new Date());
	process.stderr.write(
		`anon-pi: committing ${target.name} -> image ${imageRef} (pausing the container briefly)\u2026\n`,
	);
	const committed = spawnNetcage(['commit', target.ref, imageRef]);
	if (committed !== 0) {
		process.stderr.write(
			`anon-pi: netcage commit failed; machine ${JSON.stringify(name)} NOT created.\n`,
		);
		return committed;
	}

	// Create the machine pinned to the committed image.
	mkdirSync(machineHomeDir(env, name), {recursive: true});
	writeFileSync(
		machineJsonPath(env, name),
		serializeMachineJson({image: imageRef}),
	);

	// The source machine is the machine of the container we committed (its stamped
	// key carries it). Copy its home into the new machine's home, EXCEPT the
	// sessions subtree (conversations are handled separately below). Copying the
	// config/extensions is safe + preferable to a fresh seed here: the new image IS
	// the committed source filesystem, so the home's extensions/binaries are
	// correct-for-the-new-image (and the copied seed marker means no reseed).
	const sourceMachine = parseKeptKey(target.key).machine;
	if (sourceMachine !== undefined) {
		copyHomeMinusSessions(env, sourceMachine, name);
	}

	process.stdout.write(
		`anon-pi: snapshotted ${target.name} into machine ${JSON.stringify(name)} ` +
			`(image ${imageRef}) at ${targetDir}.\n` +
			(sourceMachine !== undefined
				? `Copied ${JSON.stringify(sourceMachine)}'s home (config + extensions) into it.\n`
				: 'Its home seeds fresh on first launch.\n'),
	);

	// Offer the source's conversation history, grouped by project, opt-in per
	// project (default none). TTY only; a non-TTY snapshot carries no sessions.
	if (sourceMachine !== undefined) {
		carryOverSessions(env, sourceMachine, name);
	}
	return 0;
}

/**
 * Recursively copy machine <source>'s home into machine <dest>'s home, EXCLUDING
 * the `.pi/agent/sessions/` subtree (conversations are carried over separately,
 * per-project, opt-in). Best-effort: an absent source home is a no-op (the dest
 * just stays fresh). Uses cpSync with a filter that rejects the sessions dir and
 * anything under it.
 */
function copyHomeMinusSessions(
	env: AnonPiEnv,
	source: string,
	dest: string,
): void {
	const srcHome = machineHomeDir(env, source);
	if (!existsSync(srcHome)) return;
	const destHome = machineHomeDir(env, dest);
	const sessionsPath = machineSessionsDir(env, source);
	cpSync(srcHome, destHome, {
		recursive: true,
		// Exclude the sessions dir itself and everything beneath it (pure predicate).
		filter: (src) => copyIncludesForHomeMinusSessions(src, sessionsPath),
	});
}

/**
 * Offer the source machine's pi conversation history (grouped BY PROJECT) as an
 * opt-in carry-over into the new machine. Each present `sessions/<slug>/` group
 * is a project row (or an orphan-slug row); DEFAULT all UNSELECTED, per-project
 * COPY or SKIP. Copy duplicates that session dir into the new home. There is NO
 * per-row move; after the copies, ONE confirmed (default No) step can delete the
 * copied groups from the SOURCE home (the only "move"). No-TTY: copy nothing.
 */
function carryOverSessions(env: AnonPiEnv, source: string, dest: string): void {
	const presentSlugs = readDirNames(machineSessionsDir(env, source));
	if (presentSlugs.length === 0) return;

	if (!process.stdin.isTTY) {
		process.stderr.write(
			`anon-pi: ${presentSlugs.length} conversation group(s) on ${JSON.stringify(source)} ` +
				'were NOT copied (no TTY to choose). The new machine starts with no history.\n',
		);
		return;
	}

	// Label rows by project name (matching the machine-invariant slug); an orphan
	// slug with no current project folder is still offered by its raw slug.
	const config = readJsonConfig(env);
	const projectsRoot = resolveProjectsRoot({env, config});
	const groups = snapshotSessionGroups({
		presentSlugs,
		projects: readDirNames(projectsRoot),
	});

	process.stderr.write(
		`anon-pi: ${JSON.stringify(source)} has ${groups.length} conversation group(s) ` +
			'(by project). Choose COPY or SKIP for each (default SKIP):\n',
	);
	const copied: SnapshotSessionGroup[] = [];
	for (const g of groups) {
		const ans = promptLine(`  ${g.label}  [copy/SKIP]: `);
		if (ans !== undefined && /^c(opy)?$/i.test(ans.trim())) {
			const from = join(machineSessionsDir(env, source), g.slug);
			const to = join(machineSessionsDir(env, dest), g.slug);
			mkdirSync(machineSessionsDir(env, dest), {recursive: true});
			cpSync(from, to, {recursive: true});
			copied.push(g);
		}
	}

	if (copied.length === 0) {
		process.stderr.write('anon-pi: no conversation groups copied.\n');
		return;
	}
	process.stderr.write(
		`anon-pi: copied ${copied.length} conversation group(s) into ${JSON.stringify(dest)}.\n`,
	);

	// The ONLY "move": an explicit, confirmed, default-No delete from the SOURCE.
	const ans = promptLine(
		`Also DELETE the ${copied.length} copied group(s) from source machine ${JSON.stringify(source)}? [y/N] `,
	);
	if (ans !== undefined && /^y(es)?$/i.test(ans.trim())) {
		for (const g of copied) {
			rmSync(join(machineSessionsDir(env, source), g.slug), {
				recursive: true,
				force: true,
			});
		}
		process.stderr.write(
			`anon-pi: removed ${copied.length} group(s) from ${JSON.stringify(source)}.\n`,
		);
	}
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

// --- `anon-pi init` onboarding (thin I/O over the pure detect/verify decisions) --
//
// init is the HONEST, re-runnable onboarding. It captures the socks5h PROXY (by
// evidence: open ports + a real SOCKS5 handshake + a real `netcage verify` exit
// IP, NEVER a provider label), the local-model ENDPOINT (generating models.json
// from it), and the default machine IMAGE (menu from shipped Dockerfiles / an
// existing ref / skip, building via `podman build`), then writes config.json +
// the `default` machine. It REPLACES the old `import`. All the DECISIONS are
// pure (anon-pi.ts); this does only the socket probes, the netcage/podman
// spawns, and the prompts. It NEVER destroys machines/homes: it pre-fills
// current values and only ADDS/updates config + a fresh default machine.

const INIT_HELP = `anon-pi init - onboard: verify your proxy, capture your local model, pick an image

USAGE
  anon-pi init                    interactive onboarding (re-runnable reconfigure)

WHAT IT DOES
  1. PROXY: probes common SOCKS ports, confirms SOCKS5 via a real handshake,
     shows the findings (EVIDENCE only, never a provider label), then runs
     \`netcage verify\` and shows the real EXIT IP as proof. You confirm.
  2. LOCAL MODEL: captures host:port, probes it, then IMPORTS models. It merges
     your pi config's matching provider ([configured], well-tuned) with the
     endpoint's live /v1/models ([server]); you pick which to import + the
     default. Only the provider served by this endpoint (the one --allow-direct
     hole) is ever read, so no other provider or key can enter the seed. Writes
     models.json + a settings seed (the default-model selection).
  3. IMAGE: pick a shipped Dockerfile (built via podman), an existing ref, or skip.
  4. PROJECTS ROOT: the host folder mounted at /projects (default ~/.anon-pi/
     projects); point it at your own dev folder, or keep the default.
  Then writes ~/.anon-pi/config.json + the \`default\` machine. Never destroys homes.

  Runs AUTOMATICALLY the first time you launch anon-pi with no config yet.

FLAGS
  --force-allow-local-llm-api-key  carry a REAL apiKey from the matching host
     provider into the seed (init refuses by default: a host credential should
     not enter the anonymized machine home unless you say so).
`;

function runInit(args: string[]): number {
	if (args.includes('--help') || args.includes('-h')) {
		process.stdout.write(INIT_HELP);
		return 0;
	}
	const FORCE_KEY_FLAG = '--force-allow-local-llm-api-key';
	const forceLocalApiKey = args.includes(FORCE_KEY_FLAG);
	const extra = args.filter((a) => a !== FORCE_KEY_FLAG);
	if (extra.length > 0) {
		process.stderr.write(
			`anon-pi: init takes no arguments (except ${FORCE_KEY_FLAG}), got: ${extra.join(' ')}. Run \`anon-pi init --help\`.\n`,
		);
		return 1;
	}

	if (!process.stdin.isTTY) {
		process.stderr.write(
			'anon-pi: init is interactive and needs a TTY. Run it in a terminal. To set\n' +
				'values non-interactively, write ~/.anon-pi/config.json + a machine.json by hand,\n' +
				'or export ANON_PI_PROXY / ANON_PI_LLM (they override config.json).\n',
		);
		return 1;
	}

	const env = envFromProcess(process.env);
	// Pre-fill from the CURRENT config (re-runnable: init doubles as reconfigure).
	const current = readJsonConfig(env);

	process.stdout.write(
		'anon-pi init: honest, evidence-based onboarding. Nothing is destroyed; your\n' +
			'current values are pre-filled. Press Ctrl-C to abort at any prompt.\n\n',
	);

	// 1) PROXY: probe + handshake + findings + netcage verify + confirm.
	const proxyHostPort = initProxyStep(current.proxy);
	if (proxyHostPort === undefined) return 1;
	const proxyUrl = socks5hUrl(proxyHostPort);

	// 2) LOCAL MODEL endpoint + model import: capture the endpoint, then merge the
	//    host config's matching provider (well-tuned) with the endpoint's live
	//    /v1/models, let the user pick which to import + the default. May ABORT
	//    (a real host apiKey without --force-allow-local-llm-api-key).
	const llmResult = initLlmStep(env, current.llm, forceLocalApiKey);
	if (llmResult === ABORT) return 1;
	const llm = llmResult.endpoint;

	// 3) DEFAULT MACHINE IMAGE: menu (shipped Dockerfiles / existing ref / skip).
	const image = initImageStep();
	if (image === ABORT) return 1;

	// 4) PROJECTS ROOT: the host dir mounted at /projects (default ~/.anon-pi/
	//    projects). Overridable per-launch with `--mount`; this sets the default.
	const projects = initProjectsStep(env, current.projects);

	// 5) WRITE config.json + the `default` machine (never destroying an existing
	//    home). The proxy is always present (we only reach here on a chosen proxy).
	const anonHome = resolveAnonPiHome(env);
	mkdirSync(anonHome, {recursive: true});
	const configPath = join(anonHome, 'config.json');
	const nextConfig: AnonPiConfig = {
		proxy: proxyUrl,
		llm: llm ?? current.llm,
		defaultMachine: current.defaultMachine ?? DEFAULT_MACHINE,
		projects: projects ?? current.projects,
	};
	writeFileSync(configPath, serializeConfigJson(nextConfig));
	process.stdout.write(`\nanon-pi: wrote ${configPath}.\n`);

	// The `default` machine: create it if absent (NEVER wipe an existing home),
	// pin/re-pin its image when one was chosen. Its home seeds on first launch.
	initWriteDefaultMachine(env, image);

	// The GLOBAL local-model models.json + settings seed, generated from the
	// captured endpoint + the CHOSEN models (this is the `import` replacement).
	const endpoint = llm ?? current.llm;
	if (endpoint !== undefined) {
		const models = generateModelsJson(
			endpoint,
			llmResult.models,
			llmResult.apiKey,
		);
		const modelsBody = JSON.stringify(models, null, '\t') + '\n';
		// GLOBAL seed: the local model is a workspace-level thing (config.llm is
		// global), so its models.json lives once at the workspace root and seeds
		// EVERY machine's fresh home. A machine may still override with its own
		// machines/<M>/models.json.
		mkdirSync(resolveAnonPiHome(env), {recursive: true});
		writeFileSync(globalModelsSeedPath(env), modelsBody);

		// Migration: earlier versions wrote this seed under machines/default/. Now
		// that it is global, remove the old default-machine copy so `default`
		// picks up the global seed like every other machine (leaving it would look
		// like a deliberate per-machine override and shadow the global one). Only
		// the `default` machine's init-generated copy is migrated; a per-machine
		// override you created for ANY OTHER machine is left untouched.
		for (const stale of [
			machineModelsSeedPath(env, DEFAULT_MACHINE),
			join(machineDir(env, DEFAULT_MACHINE), SETTINGS_SEED_FILE),
		]) {
			if (existsSync(stale)) rmSync(stale, {force: true});
		}
		process.stdout.write(
			`anon-pi: wrote the global local-model models.json ` +
				`(${llmResult.models.length} model${llmResult.models.length === 1 ? '' : 's'}; shared by all machines).\n`,
		);

		// settings.json seed: the default model + enabledModels for the imported
		// set. The first-launch promotion merges it into each home's settings (so
		// image-staged packages/extensions survive). Only when the user picked at
		// least one model + a default.
		const selection =
			llmResult.defaultId !== undefined && llmResult.models.length > 0
				? generateModelSelection(
						llmResult.models.map((m) => m.id),
						llmResult.defaultId,
					)
				: undefined;
		if (selection) {
			writeFileSync(
				globalSettingsSeedPath(env),
				JSON.stringify(selection, null, '\t') + '\n',
			);
			process.stdout.write(
				`anon-pi: default model set to "${llmResult.defaultId}".\n`,
			);
		}

		// Re-run reconfigure: the seed above only takes effect on a FRESH home
		// (the first-launch promotion is marker-guarded). Apply the new
		// models.json + settings selection DIRECTLY to EVERY already-seeded machine
		// home now, so re-running `init` updates existing environments without
		// wiping conversations (init runs on the host; homes are host dirs). Fresh
		// (unseeded) homes are left to the launch-time seed. A machine with its OWN
		// per-machine models.json override is skipped (its local model differs).
		const updated = applyModelsToSeededHomes(env, modelsBody, selection);
		if (updated.length > 0) {
			process.stdout.write(
				`anon-pi: updated ${updated.length} existing machine home${updated.length === 1 ? '' : 's'} ` +
					`(${updated.join(', ')}); conversations untouched.\n`,
			);
		}
	}

	process.stdout.write(
		'\nanon-pi: onboarding complete. Launch with `anon-pi <project>` or ' +
			'`anon-pi --shell`.\n',
	);
	return 0;
}

/**
 * Apply the freshly-generated GLOBAL local-model config to EVERY already-seeded
 * machine home directly (init runs on the host; homes are host dirs). The
 * launch-time seed only promotes on a FRESH home (marker-guarded), so without
 * this a re-run of `init` would update the global seed but never reach existing
 * homes. For each machine: skip a FRESH home (no marker — the launch seed will
 * pick up the new global seed), skip a machine with its OWN per-machine
 * models.json override (its local model differs on purpose), else overwrite the
 * home's models.json and merge the settings selection. Conversations/sessions
 * are untouched. Returns the machine names updated.
 */
function applyModelsToSeededHomes(
	env: AnonPiEnv,
	modelsBody: string,
	selection: ModelSelection | undefined,
): string[] {
	const updated: string[] = [];
	for (const machine of listMachineNames(env).sort()) {
		const agentDir = machineAgentDir(env, machine);
		// Only an already-seeded home (marker present).
		if (!existsSync(join(agentDir, SEED_MARKER))) continue;
		// A machine that deliberately overrides the global models.json keeps its
		// own local model; do not clobber its home with the global one.
		if (existsSync(machineModelsSeedPath(env, machine))) continue;

		writeFileSync(join(agentDir, MODELS_FILE), modelsBody);
		if (selection) {
			const settingsPath = join(agentDir, SETTINGS_FILE);
			const merged = mergeModelSelection(readJsonFile(settingsPath), selection);
			writeFileSync(settingsPath, JSON.stringify(merged, null, '\t') + '\n');
		}
		updated.push(machine);
	}
	return updated;
}

/** A sentinel a step returns when the user aborted (distinct from "skipped"). */
const ABORT = Symbol('abort');

/**
 * The PROXY step: probe the default SOCKS ports, confirm SOCKS5 via a real
 * handshake, show the EVIDENCE (never a provider label), let the user CHOOSE a
 * SOCKS5-confirmed port or enter host:port, then run `netcage verify` and show
 * the real EXIT IP before confirming. Returns the chosen host:port, or undefined
 * on abort. The socket probes + the netcage spawn are the only I/O; the display
 * + the handshake verdict come from the pure module.
 */
function initProxyStep(currentProxy: string | undefined): string | undefined {
	process.stdout.write(
		'Step 1/4 - proxy (the socks5h endpoint that anonymizes egress)\n',
	);
	if (currentProxy) {
		process.stdout.write(`  current: ${currentProxy}\n`);
	}
	process.stdout.write('  Probing common SOCKS ports (evidence only)...\n');

	// REUSE netcage's SOCKS scanner when available: `netcage detect-proxy --json`
	// probes the same ports + does the SOCKS5 handshake + the weak process hint,
	// and is the same evidence engine that backs `netcage setup-default`. Falling
	// back to anon-pi's own probe keeps init working on an older netcage (or if
	// the verb errors). Either way the findings render through the same PURE
	// formatter, so the honesty invariant (never label the provider) is identical.
	const detected = detectProxyViaNetcage();
	let findings: ProxyFinding[] = detected
		? findingsFromNetcageDetect(detected)
		: [];
	let processNote: string | undefined = detected
		? processNoteFromNetcageDetect(detected)
		: undefined;
	if (findings.length === 0) {
		// Local probe fallback: TCP-open + a real SOCKS5 handshake per default
		// port. The weak process hint is HOST-WIDE, gathered once as the note.
		processNote = matchProcessHint(observeRunningProcesses());
		findings = DEFAULT_SOCKS_PROBE_PORTS.map(({port, hint}) => {
			const {open, handshake} = probeSocks5('127.0.0.1', port);
			return {host: '127.0.0.1', port, open, handshake, portHint: hint};
		});
	}
	process.stdout.write(
		'\n' + formatProxyFindings(findings, processNote) + '\n\n',
	);

	// Offer the SOCKS5-confirmed candidates as quick picks; always allow a manual
	// host:port entry (and pre-fill the current one).
	const confirmed = findings.filter((f) => f.open && f.handshake?.socks5);
	for (;;) {
		if (confirmed.length > 0) {
			process.stdout.write('SOCKS5-confirmed ports:\n');
			confirmed.forEach((f, i) => {
				process.stdout.write(`  [${i + 1}] ${f.host}:${f.port}\n`);
			});
		}
		const prefill = currentProxy
			? ` (or Enter to keep ${hostPortKey(currentProxy)})`
			: '';
		const ans = promptLine(`Choose a number, or enter host:port${prefill}: `);
		if (ans === undefined) {
			process.stderr.write('anon-pi: aborted; nothing written.\n');
			return undefined;
		}
		const trimmed = ans.trim();
		let chosen: string | undefined;
		if (trimmed === '' && currentProxy) {
			chosen = hostPortKey(currentProxy);
		} else if (/^\d+$/.test(trimmed) && confirmed.length > 0) {
			const idx = Number(trimmed) - 1;
			if (idx >= 0 && idx < confirmed.length) {
				const f = confirmed[idx];
				chosen = `${f.host}:${f.port}`;
			}
		} else if (trimmed !== '') {
			chosen = hostPortKey(trimmed);
		}
		if (chosen === undefined || chosen === '') {
			process.stdout.write(
				'  Please pick a listed number or enter a host:port.\n',
			);
			continue;
		}

		// VERIFY: run `netcage verify --proxy socks5h://<chosen>` and show the real
		// exit IP as evidence it is NOT the host IP. The user confirms ON that
		// evidence. netcage never announces the provider, so neither do we.
		const url = socks5hUrl(chosen);
		process.stdout.write(
			`\n  Verifying via netcage: netcage verify --proxy ${url}\n`,
		);
		if (!hasNetcage()) {
			process.stderr.write(
				'anon-pi: `netcage` not found on PATH, cannot verify the exit IP. Install\n' +
					'it first (https://github.com/wighawag/netcage). Linux only.\n',
			);
			return undefined;
		}
		const verify = spawnSync('netcage', ['verify', '--proxy', url], {
			encoding: 'utf8',
		});
		const output = `${verify.stdout ?? ''}${verify.stderr ?? ''}`;
		if (verify.error || verify.status !== 0) {
			process.stdout.write(output.trimEnd() + '\n');
			process.stdout.write(
				`  netcage verify FAILED for ${url} (exit ${verify.status ?? 'n/a'}). ` +
					'Pick another port or fix the proxy.\n\n',
			);
			continue;
		}
		const exitIp = parseVerifyExitIp(output);
		if (exitIp) {
			process.stdout.write(
				`  Exit IP (via the proxy, NOT your host): ${exitIp}\n`,
			);
		} else {
			process.stdout.write(
				'  netcage verify succeeded but no exit IP was parsed; raw output:\n' +
					output.trimEnd() +
					'\n',
			);
		}
		const ok = promptLine(`  Use ${url} as your proxy? [Y/n] `);
		if (ok === undefined) {
			process.stderr.write('anon-pi: aborted; nothing written.\n');
			return undefined;
		}
		if (/^n(o)?$/i.test(ok.trim())) {
			process.stdout.write('  OK, pick another.\n\n');
			continue;
		}
		return chosen;
	}
}

/** What initLlmStep resolves: the endpoint, the chosen model entries, the apiKey to seed, and the default id. */
interface LlmStepResult {
	endpoint: string | undefined;
	models: GeneratedModel[];
	apiKey: string;
	defaultId: string | undefined;
}

/**
 * The LOCAL MODEL step: capture host:port (pre-filled from config), probe TCP
 * reachability, then IMPORT models. It merges TWO sources, both scoped to the
 * endpoint (the one `--allow-direct` hole, so no other provider can enter the
 * seed): the host `~/.pi/agent/models.json` provider whose baseUrl matches the
 * endpoint (well-tuned entries, marked [configured]) and the endpoint's live
 * `/v1/models` (bare ids, marked [server]). The user picks which to import and
 * the default. Returns the endpoint + chosen entries + apiKey + default, or
 * ABORT (a real host apiKey without --force-allow-local-llm-api-key).
 */
function initLlmStep(
	env: AnonPiEnv,
	currentLlm: string | undefined,
	forceLocalApiKey: boolean,
): LlmStepResult | typeof ABORT {
	process.stdout.write(
		'\nStep 2/4 - local model endpoint (the ONE direct hole)\n',
	);
	if (currentLlm) process.stdout.write(`  current: ${currentLlm}\n`);
	const prefill = currentLlm
		? ` (or Enter to keep ${currentLlm})`
		: ' (or Enter to skip)';
	const ans = promptLine(
		`  Local model host:port, e.g. 192.168.1.150:8080${prefill}: `,
	);
	const raw = ans === undefined ? '' : ans.trim();
	const endpoint = raw === '' ? currentLlm : raw;
	if (endpoint === undefined) {
		// No endpoint at all: nothing to import.
		return {
			endpoint: undefined,
			models: [],
			apiKey: LOCAL_PROVIDER_API_KEY,
			defaultId: undefined,
		};
	}

	// Probe reachability: evidence only. A closed port is not fatal (the model may
	// start later); we just report it.
	const key = hostPortKey(endpoint);
	const colon = key.lastIndexOf(':');
	const host = colon > 0 ? key.slice(0, colon) : key;
	const port = colon > 0 ? Number(key.slice(colon + 1)) : 80;
	const reachable = Number.isFinite(port) ? probeTcp(host, port) : false;
	process.stdout.write(
		reachable
			? `  reachable: ${host}:${port} accepted a TCP connection.\n`
			: `  note: ${host}:${port} did not accept a connection now (the model may not be up yet).\n`,
	);

	// SOURCE A: the host models.json provider matching this endpoint (only that
	// one — the anonymity scoping). Its apiKey is checked: a REAL key is refused
	// unless --force-allow-local-llm-api-key.
	const hostModels = readJsonFile(resolveHostModelsPath(env));
	const match = pickLocalProviderModels(
		(hostModels as PiModelsFile) ?? {},
		endpoint,
	);
	let apiKey = LOCAL_PROVIDER_API_KEY;
	if (match && match.apiKeyLooksReal) {
		if (!forceLocalApiKey) {
			process.stderr.write(
				`\n  anon-pi: the matching provider in your pi config carries a real-looking\n` +
					`  apiKey. Seeding it would put a host credential into the anonymized machine\n` +
					`  home. Refusing. If this key is genuinely safe for the local model, re-run\n` +
					`  \`anon-pi init --force-allow-local-llm-api-key\` to carry it through.\n`,
			);
			return ABORT;
		}
		apiKey = (match.apiKey ?? LOCAL_PROVIDER_API_KEY).trim();
		process.stdout.write(
			'  WARNING: carrying the host provider apiKey into the seed (--force-allow-local-llm-api-key).\n',
		);
	}
	const hostModelEntries = match?.models ?? [];

	// SOURCE B: the endpoint's live /v1/models (bare ids).
	let serverIds: string[] = [];
	if (Number.isFinite(port)) {
		const listing = fetchModelsListing(host, port);
		serverIds = parseModelsListing(listing);
	}

	if (hostModelEntries.length === 0 && serverIds.length === 0) {
		process.stdout.write(
			'  No models found (no matching provider in your pi config, and the server\n' +
				'  returned none). The provider is still seeded; add models in pi later.\n',
		);
		return {endpoint, models: [], apiKey, defaultId: undefined};
	}

	const candidates = mergeModelSources(hostModelEntries, serverIds);
	const chosen = initModelPicker(candidates);
	if (chosen === undefined) {
		// Skip: seed the provider with no models.
		return {endpoint, models: [], apiKey, defaultId: undefined};
	}
	const defaultId = initDefaultModelPicker(chosen);
	return {endpoint, models: chosen, apiKey, defaultId};
}

/**
 * Present the merged candidate list and let the user choose which to import.
 * Options: Enter/`c` = all CONFIGURED (host-tuned; the safe default), `a` = ALL
 * (server + configured), space/comma-separated NUMBERS = those, `s` = skip.
 * Returns the chosen entries, or undefined to skip (seed no models).
 */
function initModelPicker(
	candidates: readonly ModelCandidate[],
): GeneratedModel[] | undefined {
	const configured = candidates.filter((c) => c.configured);
	process.stdout.write('\n  Models served by this endpoint:\n');
	candidates.forEach((c, i) => {
		const tag = c.configured ? '[configured]' : '[server]';
		process.stdout.write(`    [${i + 1}] ${c.id} ${tag}\n`);
	});
	process.stdout.write(
		'  [configured] = from your pi config (well-tuned); [server] = the server\n' +
			'  also reports it (a minimal entry is synthesized).\n',
	);
	const hasConfigured = configured.length > 0;
	const defaultHint = hasConfigured
		? 'Enter/c = all configured, a = all, numbers = pick, s = skip'
		: 'Enter/a = all, numbers = pick, s = skip';
	for (;;) {
		const ans = promptLine(`  Import which? (${defaultHint}): `);
		const v = (ans ?? '').trim().toLowerCase();
		if (v === 's') return undefined;
		if (v === '' && hasConfigured) return configured.map((c) => c.entry);
		if (v === 'c') {
			if (!hasConfigured) {
				process.stdout.write(
					'  No [configured] models; pick numbers or `a` for all.\n',
				);
				continue;
			}
			return configured.map((c) => c.entry);
		}
		if (v === 'a' || (v === '' && !hasConfigured)) {
			return candidates.map((c) => c.entry);
		}
		// Numbers (space/comma separated).
		const picks = v
			.split(/[\s,]+/)
			.filter((t) => t !== '')
			.map((t) => Number(t) - 1);
		if (
			picks.length > 0 &&
			picks.every((i) => i >= 0 && i < candidates.length)
		) {
			// De-dup, keep list order.
			const seen = new Set<number>();
			const out: GeneratedModel[] = [];
			for (const i of picks) {
				if (!seen.has(i)) {
					seen.add(i);
					out.push(candidates[i].entry);
				}
			}
			return out;
		}
		process.stdout.write(
			`  Please enter Enter/c/a/s or numbers 1-${candidates.length}.\n`,
		);
	}
}

/**
 * Pick the DEFAULT model among the chosen ones. Defaults to the first (Enter);
 * accepts a number. Returns the chosen id.
 */
function initDefaultModelPicker(chosen: readonly GeneratedModel[]): string {
	if (chosen.length === 1) return chosen[0].id;
	process.stdout.write('\n  Which is the DEFAULT model?\n');
	chosen.forEach((m, i) => {
		process.stdout.write(`    [${i + 1}] ${m.id}\n`);
	});
	for (;;) {
		const ans = promptLine(
			`  Default [1-${chosen.length}] (Enter = ${chosen[0].id}): `,
		);
		const v = (ans ?? '').trim();
		if (v === '') return chosen[0].id;
		const idx = Number(v) - 1;
		if (Number.isInteger(idx) && idx >= 0 && idx < chosen.length) {
			return chosen[idx].id;
		}
		process.stdout.write(`  Please pick a number 1-${chosen.length}.\n`);
	}
}

/**
 * The IMAGE step: the pure menu (shipped Dockerfiles / existing ref / skip), then
 * the impure action for the pick (build via `podman build`, take a ref, or
 * skip). Returns the resolved image ref, undefined for skip, or ABORT.
 */
function initImageStep(): string | undefined | typeof ABORT {
	process.stdout.write(
		'\nStep 3/4 - default machine image (an image with `pi` on PATH)\n',
	);
	const menu = initImageMenu();
	menu.forEach((e, i) => {
		process.stdout.write(`  [${i + 1}] ${e.label}\n`);
	});
	for (;;) {
		const ans = promptLine('  Choose [1-4]: ');
		if (ans === undefined) return ABORT;
		const idx = Number(ans.trim()) - 1;
		if (!Number.isInteger(idx) || idx < 0 || idx >= menu.length) {
			process.stdout.write('  Please pick a number 1-4.\n');
			continue;
		}
		const choice: InitImageChoice = menu[idx].choice;
		if (choice === 'skip') {
			process.stdout.write(
				'  Skipping the image; pin it later with `anon-pi machine set-image`.\n',
			);
			return undefined;
		}
		if (choice === 'existing') {
			const ref = promptLine('  Image ref (a container with `pi` on PATH): ');
			if (ref === undefined || ref.trim() === '') {
				process.stdout.write('  No ref given; pick again.\n');
				continue;
			}
			return ref.trim();
		}
		// basic | webveil: build the shipped Dockerfile via `podman build`.
		const dockerfile =
			choice === 'basic'
				? shippedDockerfilePath()
				: shippedWebveilDockerfilePath();
		if (dockerfile === undefined || !existsSync(dockerfile)) {
			process.stderr.write(
				`  anon-pi: could not locate the shipped ${choice === 'basic' ? 'Dockerfile.pi' : 'examples/Dockerfile.pi-webveil'}. ` +
					'Pick an existing ref instead.\n',
			);
			continue;
		}
		// Fully-qualified `localhost/` tag: podman refuses an UNQUALIFIED short name
		// at run time ("did not resolve to an alias and no unqualified-search
		// registries defined"), so a locally-built image MUST carry the localhost/
		// prefix to be runnable by name.
		const tag =
			choice === 'basic'
				? 'localhost/anon-pi/pi:latest'
				: 'localhost/anon-pi/pi-webveil:latest';
		const built = buildImage(dockerfile, tag);
		if (!built) {
			process.stdout.write('  Build failed; pick another option.\n');
			continue;
		}
		return tag;
	}
}

/**
 * The PROJECTS-ROOT step: the host directory mounted into the jail at /projects
 * (pi's cwd; a project is /projects/<name>). It defaults to the built-in
 * `~/.anon-pi/projects/`; the user may point it at their own dev folder so bare
 * `anon-pi` works there without passing `--mount` every time. `--mount <parent>`
 * still overrides it per-launch. Returns the chosen root, or undefined to keep
 * the current/default (so an omitted `projects` in config.json means the
 * built-in default). Enter accepts the shown default.
 */
function initProjectsStep(
	env: AnonPiEnv,
	currentProjects: string | undefined,
): string | undefined {
	process.stdout.write(
		'\nStep 4/4 - projects root (the host folder mounted at /projects)\n',
	);
	const builtin = builtinProjectsRoot(env);
	const shown = currentProjects ?? builtin;
	if (currentProjects) {
		process.stdout.write(`  current: ${currentProjects}\n`);
	}
	process.stdout.write(
		'  This is where bare `anon-pi` looks for projects. Point it at your own\n' +
			'  dev folder to jail pi into files you edit with host tools; `--mount\n' +
			'  <parent>` still overrides it per-launch. Leave it at the default if\n' +
			"  you're unsure.\n",
	);
	const ans = promptLine(`  Projects root (Enter to keep ${shown}): `);
	if (ans === undefined) return currentProjects;
	const trimmed = ans.trim();
	if (trimmed === '') return currentProjects;
	// Expand a leading `~` (path.resolve does NOT — it would make a literal `~`
	// dir), then absolutize. Store the built-in as "unset" (undefined) so
	// config.json stays clean when the user just accepts the default path.
	const chosen = resolve(expandTilde(trimmed, env.home));
	if (chosen === builtin) return undefined;
	return chosen;
}

/**
 * Create or update the `default` machine: create it (dir + machine.json) if
 * absent, pinning the chosen image; if it already exists, re-pin the image only
 * when one was chosen (preserving any per-machine projects override), and NEVER
 * touch its home (init is non-destructive). A skipped image leaves an existing
 * machine's image as-is, or creates an imageless machine.
 */
function initWriteDefaultMachine(
	env: AnonPiEnv,
	image: string | undefined,
): void {
	const name = DEFAULT_MACHINE;
	const dir = machineDir(env, name);
	const existed = existsSync(dir);
	mkdirSync(machineHomeDir(env, name), {recursive: true});
	if (!existed) {
		writeFileSync(machineJsonPath(env, name), serializeMachineJson({image}));
		process.stdout.write(
			`anon-pi: created machine "${name}"${image ? ` (image ${image})` : ' (imageless; pin it later)'} at ${dir}.\n`,
		);
		return;
	}
	// Existing machine: re-pin only if a new image was chosen; keep its projects
	// override and its home untouched.
	const prev = readMachineJson(env, name);
	if (image !== undefined) {
		writeFileSync(
			machineJsonPath(env, name),
			serializeMachineJson({image, projects: prev.projects}),
		);
		process.stdout.write(
			`anon-pi: re-pinned machine "${name}" image to ${image} (home kept intact).\n`,
		);
	} else {
		process.stdout.write(
			`anon-pi: machine "${name}" already exists; kept its image + home.\n`,
		);
	}
}

// --- init's thin I/O primitives (socket probes, process observe, podman build) --

/**
 * Probe a TCP port for openness AND a SOCKS5 handshake: connect, send the
 * no-auth method-selection greeting, read the reply, and interpret it with the
 * PURE interpretSocks5Handshake. Fully synchronous + best-effort with a short
 * timeout so init stays a simple linear prompt flow. On any connect failure the
 * port is `open: false` with no handshake.
 */
function probeSocks5(
	host: string,
	port: number,
): {open: boolean; handshake?: SocksHandshake} {
	// A synchronous SOCKS5 probe: node's net is async, so we drive a tiny state
	// machine over a blocking loop using a short deadline. To keep it simple and
	// dependency-free we use a child `bash`+`/dev/tcp`-style probe is unavailable
	// portably, so instead we do a promise-free spin with a hard cap via a
	// separate helper that returns synchronously.
	const reply = socks5Handshake(host, port, SOCKS5_METHOD_SELECTOR, 600);
	if (reply === undefined) return {open: false};
	return {open: true, handshake: interpretSocks5Handshake(reply)};
}

/**
 * Best-effort synchronous SOCKS5 handshake: open a TCP connection, write the
 * greeting, and collect the reply bytes, blocking up to `timeoutMs`. Returns the
 * reply bytes when the connection opened (possibly empty if the server sent
 * nothing), or undefined when the connection could not be opened at all (port
 * closed / refused). Implemented with a nested event loop drained via a shared
 * flag, so the caller stays a simple linear script.
 */
function socks5Handshake(
	host: string,
	port: number,
	greeting: readonly number[],
	timeoutMs: number,
): number[] | undefined {
	// node has no synchronous socket API; run a tiny worker via execFileSync on
	// the same node binary so the probe is fully synchronous and portable. The
	// worker connects, sends the greeting, reads up to 2 bytes, and prints them as
	// JSON (or prints "null" when the connection was refused).
	const script =
		`const net=require('net');` +
		`const s=net.connect({host:${JSON.stringify(host)},port:${port}});` +
		`let done=false;const bytes=[];` +
		`const fin=(v)=>{if(done)return;done=true;try{s.destroy()}catch(e){}` +
		`process.stdout.write(JSON.stringify(v));process.exit(0)};` +
		`s.setTimeout(${timeoutMs});` +
		`s.on('connect',()=>{s.write(Buffer.from(${JSON.stringify([...greeting])}))});` +
		`s.on('data',(d)=>{for(const b of d)bytes.push(b);if(bytes.length>=2)fin(bytes)});` +
		`s.on('timeout',()=>fin(bytes));` +
		`s.on('error',()=>fin(null));` +
		`s.on('close',()=>fin(bytes));`;
	try {
		const out = execFileSync(process.execPath, ['-e', script], {
			encoding: 'utf8',
			timeout: timeoutMs + 1500,
		});
		const parsed = JSON.parse(out) as number[] | null;
		return parsed === null ? undefined : parsed;
	} catch {
		return undefined;
	}
}

/**
 * Best-effort synchronous TCP reachability probe (open a connection, succeed or
 * not) for the local-model endpoint. Reuses the socks5Handshake worker with an
 * empty greeting: a non-undefined return means the connection opened.
 */
function probeTcp(host: string, port: number): boolean {
	return socks5Handshake(host, port, [], 500) !== undefined;
}

/**
 * Best-effort SYNCHRONOUS HTTP GET of `http://<host:port>/v1/models` (the
 * OpenAI-compatible model listing llama.cpp / vLLM / LM Studio serve). Runs a
 * tiny worker on the same node binary (node has no sync HTTP), which fetches +
 * prints the body, so init stays synchronous. Returns the PARSED JSON body, or
 * undefined on any failure (unreachable / timeout / non-JSON) — init then falls
 * back to manual entry. This is a DIRECT LAN fetch on the operator's host at
 * init time (not inside the jail); it only ever touches the local-model
 * endpoint, the same host:port that becomes the one `--allow-direct` hole.
 */
function fetchModelsListing(host: string, port: number): unknown {
	const timeoutMs = 3000;
	const script =
		`const http=require('http');` +
		`const req=http.get({host:${JSON.stringify(host)},port:${port},path:'/v1/models',timeout:${timeoutMs}},(res)=>{` +
		`let b='';res.on('data',(c)=>{b+=c;if(b.length>1_000_000)req.destroy()});` +
		`res.on('end',()=>{process.stdout.write(b);process.exit(0)})});` +
		`req.on('timeout',()=>{req.destroy();process.exit(1)});` +
		`req.on('error',()=>process.exit(1));`;
	try {
		const out = execFileSync(process.execPath, ['-e', script], {
			encoding: 'utf8',
			timeout: timeoutMs + 1500,
			maxBuffer: 4 * 1024 * 1024,
		});
		return JSON.parse(out);
	} catch {
		return undefined;
	}
}

/**
 * Observe LOCAL process names (best-effort) so init can offer WEAK hints (a
 * running `tor` -> likely Tor). Returns the lowercased process names seen, or []
 * on any failure. This is a LOCAL observation only; it never claims the exit
 * provider.
 */
function observeRunningProcesses(): string[] {
	const res = spawnSync('ps', ['-eo', 'comm='], {encoding: 'utf8'});
	if (res.error || res.status !== 0 || !res.stdout) return [];
	return res.stdout
		.split('\n')
		.map((l) => l.trim().split('/').pop() ?? '')
		.filter((n) => n !== '')
		.map((n) => n.toLowerCase());
}

/**
 * The weak process-hint text for the observed processes, if any maps (via the
 * PURE processHint). Returns the FIRST matching hint (tor before wireproxy), or
 * undefined. Never names the exit provider.
 */
function matchProcessHint(processes: readonly string[]): string | undefined {
	for (const p of processes) {
		const h = processHint(p);
		if (h) return h.hint;
	}
	return undefined;
}

/** Whether `netcage <verb>` exists (probe its help; false on any spawn error). */
function hasNetcageVerb(verb: string): boolean {
	const res = spawnSync('netcage', [verb, '--help'], {stdio: 'ignore'});
	if (res.error) return false;
	// netcage prints an "unknown subcommand" error (non-zero) for a missing verb,
	// and help (exit 0) for a real one. Treat exit 0 as "exists".
	return res.status === 0;
}

/**
 * Run `netcage detect-proxy --json` and parse it, to REUSE netcage's SOCKS
 * scanner (probe + handshake + process hint + exit-IP verify) in `init`. Returns
 * the parsed result, or undefined when netcage lacks the verb / errors / emits
 * non-JSON — in which case init falls back to its own local probe. Best-effort;
 * never throws.
 */
function detectProxyViaNetcage(): NetcageDetectProxy | undefined {
	const res = spawnSync('netcage', ['detect-proxy', '--json'], {
		encoding: 'utf8',
		timeout: 20000,
	});
	if (res.error || res.status !== 0 || !res.stdout) return undefined;
	try {
		const parsed = JSON.parse(res.stdout) as NetcageDetectProxy;
		return parsed && typeof parsed === 'object' ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Build a shipped Dockerfile into `tag`, landing it in the SAME store
 * `netcage run` reads.
 *
 * Since netcage v0.7.0 that store is netcage's private podman graphroot
 * (`--root <graphroot>`), NOT the operator's default rootless store, so a plain
 * `podman build` would put the image where `netcage run` cannot see it (it would
 * try to pull the `localhost/…` ref and fail). We therefore:
 *   1. PREFER `netcage build` when netcage exposes it (netcage >= 0.7.1; netcage
 *      owns its store + graphroot, no path hardcoded here); else
 *   2. `podman build` into the default store, then `podman save | podman --root
 *      <graphroot> load` to copy it into netcage's store (the fallback for an
 *      older netcage without the build/load verbs).
 * Streams output (inherited stdio) so the user sees the build. Returns true on
 * success. The build CONTEXT is the Dockerfile's own directory.
 */
function buildImage(dockerfile: string, tag: string): boolean {
	const context = dirname(dockerfile);

	// 1) Prefer a native `netcage build` (it targets netcage's own store).
	if (hasNetcageVerb('build')) {
		process.stdout.write(`  Building ${tag} via \`netcage build\`...\n`);
		const res = spawnSync(
			'netcage',
			['build', '-t', tag, '-f', dockerfile, context],
			{stdio: 'inherit'},
		);
		if (res.error) {
			process.stderr.write(
				`  anon-pi: failed to run netcage build: ${res.error.message}\n`,
			);
			return false;
		}
		return res.status === 0;
	}

	// 2) Interim: podman build into the default store, then load into netcage's
	//    graphroot so `netcage run` can find it.
	process.stdout.write(
		`  Building ${tag} from ${dockerfile} (podman build)...\n`,
	);
	const build = spawnSync(
		'podman',
		['build', '-t', tag, '-f', dockerfile, context],
		{stdio: 'inherit'},
	);
	if (build.error) {
		process.stderr.write(
			`  anon-pi: failed to run podman: ${build.error.message}. Is podman installed?\n`,
		);
		return false;
	}
	if (build.status !== 0) return false;

	return loadImageIntoNetcageStore(tag);
}

/**
 * Copy a locally-built image (in the default podman store) INTO netcage's
 * private graphroot store, so `netcage run <tag>` finds it without a pull. Uses
 * `podman save <tag> | podman --root <graphroot> load`. Best-effort: on failure
 * it warns (the image still exists in the default store; on netcage >= 0.7.1 the
 * `netcage build`/`load` verbs remove this dance). Returns true on success.
 */
function loadImageIntoNetcageStore(tag: string): boolean {
	const graphroot = resolveNetcageGraphroot(process.env);
	process.stdout.write(
		`  Loading ${tag} into netcage's store (${graphroot}) so \`netcage run\` sees it...\n`,
	);
	// `podman save <tag> | podman --root <graphroot> load`, via a shell so the
	// pipe is a single spawn (both ends inherit stderr for progress).
	const cmd =
		`podman save ${shQuote(tag)} | ` +
		`podman --root ${shQuote(graphroot)} load`;
	const res = spawnSync('sh', ['-c', cmd], {
		stdio: ['ignore', 'inherit', 'inherit'],
	});
	if (res.error || res.status !== 0) {
		process.stderr.write(
			`  anon-pi: could not load ${tag} into netcage's store (${graphroot}).\n` +
				`  The image is built in your default podman store, but \`netcage run\` reads\n` +
				`  ${graphroot}. Load it by hand:\n` +
				`    podman save ${tag} | podman --root ${graphroot} load\n`,
		);
		return false;
	}
	return true;
}

/** Minimal POSIX single-quote shell-quoting for a token embedded in `sh -c`. */
function shQuote(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
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

/** The `forward` subcommand help. */
const FORWARD_HELP = `anon-pi forward - open a host port onto a running anon-pi container's in-jail server

USAGE
  anon-pi forward [<project>] [--port <[hostPort:]jailPort>] [--bind <addr>] [-m <machine>]

  <project>   filter to a running container for THIS project (a numeric name is a
              project, never a port). Omitted => all running anon-pi containers.
  --port,-p   the port to forward, host-first like docker/kubectl: 3001 (host
              3001 -> jail 3001) or 8080:3001 (host 8080 -> jail 3001). Omit to be
              shown the container's open ports and prompted (incl. a different
              host port). An explicit port may be one not open yet.
  --bind      passed through to netcage (127.0.0.1 default, or 0.0.0.0 for LAN).
  -m          the machine the container runs on (else the default machine).

Wraps \`netcage forward\` (netcage >= 0.10.0). If several containers match, you pick
one (each row shows its open in-jail ports). The forward runs until Ctrl-C.
`;

/** The `ports` subcommand help. */
const PORTS_HELP = `anon-pi ports - list a running anon-pi container's open in-jail TCP listeners

USAGE
  anon-pi ports [<project>] [-m <machine>]

Wraps \`netcage ports --json\` (netcage >= 0.10.0), which reads the jail's
/proc/net/tcp* image-independently (works even with no ss/netstat in the image).
Use it to find which port to \`anon-pi forward\`.
`;

/** The `machine` subcommand help. */
const MACHINE_HELP = `anon-pi machine - manage machines (an image + a persistent host home)

USAGE
  anon-pi machine create <name> [--image <ref>]   create a machine, pin its image
  anon-pi machine list                            list machines and their images
  anon-pi machine set-image <name> <ref>          re-pin the image (WARNS; no reseed)
  anon-pi machine rm <name> [--yes]               delete the machine + its home
  anon-pi machine snapshot <new-name> [-m <machine>] [--image-tag <ref>]
                                                  commit a RUNNING container into a
                                                  new image + create <new-name>

A machine is an image + a persistent host home (machines/<name>/{machine.json,home/}).
The home is seeded on FIRST LAUNCH, not at create. \`set-image\` re-pins only and
warns (the home was built for the old image); \`rm\` confirms on a TTY, skips with
\`--yes\`, and aborts non-interactively without it.

\`snapshot\` captures the CURRENT filesystem of a RUNNING jailed container (e.g.
after \`sudo apt install\`) into a new image and creates <new-name> pinned to it,
so you can preserve an environment you built interactively WITHOUT having
pre-decided \`--keep\`. The container is auto-detected from the running anon-pi
containers (a picker when several are up); \`-m <machine>\` is an OPTIONAL filter,
not a required source. The container must still be RUNNING (do not exit the
session); podman pauses it briefly during the commit. Same forced-egress jail on
relaunch.

The source machine's HOME is copied into the new machine (config + extensions +
dotfiles), MINUS its conversations. Conversations are offered separately, grouped
BY PROJECT, opt-in per project (default SKIP), COPY or SKIP each (no TTY => none
copied). After copying, one confirmed step (default No) can DELETE the copied
groups from the source machine (the only "move"); COPY never touches the source.
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
	// Ask netcage for ALL its managed containers as JSON (netcage >= 0.10.0
	// forwards podman's --format json over its managed scope), then keep the ones
	// carrying an anon-pi.key label (a sidecar has none) and decode it. -a so a
	// STOPPED kept container is included (run-vs-start resumes it).
	return queryManagedContainers({all: true}).map(({key, ref}) => ({key, ref}));
}

/**
 * Decode a base64 anon-pi.key label back to its identity key (the reverse of
 * withKeyLabel's encode; keptContainerKey embeds newlines, so it is base64'd to
 * stay a single safe label value). undefined on a decode error.
 */
function decodeKeyLabel(raw: string): string | undefined {
	try {
		return Buffer.from(raw, 'base64').toString('utf8');
	} catch {
		return undefined;
	}
}

/**
 * The shared `netcage ps --format json` query: parse the JSON to anon-pi's
 * containers (pure parseNetcagePsJson keeps only anon-pi.key-labelled entries,
 * optionally running-only), then base64-DECODE each key. Best-effort: [] on any
 * failure. `all` => `-a` (include stopped); else running only.
 */
function queryManagedContainers(opts: {
	all?: boolean;
}): {key: string; ref: string; name: string}[] {
	const args = ['ps'];
	if (opts.all) args.push('-a');
	args.push('--filter', 'label=netcage.managed', '--format', 'json');
	const res = spawnSync('netcage', args, {encoding: 'utf8'});
	if (res.error || res.status !== 0 || !res.stdout) return [];
	const out: {key: string; ref: string; name: string}[] = [];
	for (const e of parseNetcagePsJson(res.stdout, {runningOnly: !opts.all})) {
		const key = decodeKeyLabel(e.key);
		if (key !== undefined) out.push({key, ref: e.ref, name: e.name});
	}
	return out;
}

// --- `forward` / `ports`: reach an in-jail server from the host --------------

/**
 * Query netcage for its RUNNING managed containers (no `-a`, so a stopped kept
 * container is excluded: forward/ports can only reach a live jail), surfacing
 * each one's stamped anon-pi key + a display name. Best-effort: [] on any
 * failure, so the caller reports "nothing running" cleanly.
 */
function queryRunningContainers(): ManagedContainer[] {
	return queryManagedContainers({all: false});
}

/**
 * Best-effort: the in-jail TCP listeners of a container via `netcage ports
 * <ref> --json` (netcage >= 0.9.0). [] on any failure (older netcage without
 * the verb, a parse miss), so the port hint is purely additive and never blocks
 * a forward.
 */
function queryNetcagePorts(ref: string): NetcageListener[] {
	const res = spawnSync('netcage', ['ports', ref, '--json'], {
		encoding: 'utf8',
	});
	if (res.error || res.status !== 0 || !res.stdout) return [];
	return parseNetcagePortsJson(res.stdout);
}

/**
 * Resolve the ONE running anon-pi container a forward/ports should act on:
 * filter the running managed containers by machine (+ project if given), then
 * 0 => error (nothing running), 1 => it, many => an arrow-key picker annotated
 * with each container's open in-jail ports. Returns undefined on no-match or a
 * cancelled pick (with the reason printed). TTY is required only for the picker.
 */
function resolveForwardTarget(
	machine: string,
	project: string | undefined,
	verb: string,
): ManagedContainer | undefined {
	const running = queryRunningContainers();
	const matches = resolveManagedMatches({
		containers: running,
		machine,
		project,
	});
	if (matches.length === 0) {
		const scope =
			project !== undefined
				? `project ${JSON.stringify(project)} on machine ${JSON.stringify(machine)}`
				: `machine ${JSON.stringify(machine)}`;
		process.stderr.write(
			`anon-pi: no running anon-pi container for ${scope}. ` +
				`Start one first (e.g. \`anon-pi ${project ?? '<project>'}\`) and run its ` +
				`server, then \`anon-pi ${verb}\` again.\n`,
		);
		return undefined;
	}
	if (matches.length === 1) return matches[0];

	// Many: pick one. Each row is annotated with the container's open ports (a
	// best-effort hint), so the user can tell the sessions apart.
	if (!process.stdin.isTTY) {
		process.stderr.write(
			`anon-pi: ${matches.length} running containers match; a terminal is needed to ` +
				`pick one. Narrow with a project (\`anon-pi ${verb} <project>\`) or -m <machine>.\n`,
		);
		return undefined;
	}
	const entries: MenuEntry[] = matches.map((c) => {
		const proj = keyProject(parseKeptKey(c.key));
		const label = proj === '' ? '(shell)' : proj;
		const hint = formatPortsHint(queryNetcagePorts(c.ref));
		return {
			kind: 'project',
			project: c.ref,
			label: `${label} [${c.name}] ${hint}`,
		};
	});
	const picked = select(entries, {
		header: `anon-pi: pick a container to ${verb} (\u2191/\u2193 move, Enter select, Ctrl-C quit)`,
	});
	if (picked === undefined) {
		process.stderr.write('anon-pi: cancelled; nothing forwarded.\n');
		return undefined;
	}
	return matches.find((c) => c.ref === picked.project);
}

/**
 * Resolve the ONE running anon-pi container to act on, for `machine snapshot`.
 * The container is what matters; `machine` is an OPTIONAL narrowing filter
 * (undefined = every running anon-pi container qualifies). 0 => error (start a
 * session first), 1 => it, many => an arrow-key picker labelled by each
 * container's machine + project + name (so a cross-machine list is
 * distinguishable). Returns undefined on no-match or a cancelled pick (reason
 * printed). TTY needed only for the picker.
 */
function resolveRunningContainer(
	machine: string | undefined,
	verb: string,
): ManagedContainer | undefined {
	const matches = resolveManagedMatches({
		containers: queryRunningContainers(),
		machine,
		project: undefined,
	});
	const scope =
		machine !== undefined ? ` for machine ${JSON.stringify(machine)}` : '';
	if (matches.length === 0) {
		process.stderr.write(
			`anon-pi: no running anon-pi container${scope}. ` +
				'Start a session (e.g. `anon-pi <project>`), do your work, and ' +
				`WITHOUT exiting run \`anon-pi machine ${verb}\` from another terminal.\n`,
		);
		return undefined;
	}
	if (matches.length === 1) return matches[0];

	if (!process.stdin.isTTY) {
		process.stderr.write(
			`anon-pi: ${matches.length} running containers${scope}; a terminal is needed ` +
				'to pick one (or narrow with `-m <machine>`).\n',
		);
		return undefined;
	}
	const entries: MenuEntry[] = matches.map((c) => {
		const f = parseKeptKey(c.key);
		const proj = keyProject(f);
		const label = proj === '' ? '(shell)' : proj;
		return {
			kind: 'project',
			project: c.ref,
			label: `${f.machine ?? '?'} / ${label} [${c.name}]`,
		};
	});
	const picked = select(entries, {
		header: `anon-pi: pick a container to ${verb} (\u2191/\u2193 move, Enter select, Ctrl-C quit)`,
	});
	if (picked === undefined) {
		process.stderr.write('anon-pi: cancelled; nothing snapshotted.\n');
		return undefined;
	}
	return matches.find((c) => c.ref === picked.project);
}

/**
 * `anon-pi forward [<project>] [--port <[hostPort:]jailPort>] [--bind <addr>]
 * [-m <machine>]`: open a host->jail port on a running anon-pi container. Wraps
 * `netcage forward`. When --port is omitted, it lists the container's open
 * in-jail ports and prompts for the jail port + an optional different host port.
 */
function runForward(forwardArgs: string[]): number {
	if (forwardArgs.includes('--help') || forwardArgs.includes('-h')) {
		process.stdout.write(FORWARD_HELP);
		return 0;
	}
	if (!hasNetcage()) return netcageMissing();

	let cmd;
	try {
		cmd = parseForwardArgs(forwardArgs);
	} catch (e) {
		return reportAnonPiError(e);
	}

	const machine = resolveVerbMachine(cmd.machine, cmd.machineExplicit);
	const target = resolveForwardTarget(machine, cmd.project, 'forward');
	if (target === undefined) return 1;

	// Resolve the port: --port wins; else prompt from the container's listeners.
	let portRaw: string;
	if (cmd.port !== undefined) {
		portRaw = cmd.port.raw;
	} else {
		const prompted = promptForwardPort(target.ref);
		if (prompted === undefined) return 1;
		portRaw = prompted;
	}

	const argv = ['forward'];
	if (cmd.bind !== undefined) argv.push('--bind', cmd.bind);
	argv.push(target.ref, portRaw);
	process.stderr.write(
		`anon-pi: forwarding to ${target.name} (${portRaw}); Ctrl-C to stop\u2026\n`,
	);
	return spawnNetcage(argv);
}

/**
 * Interactive port resolution when `--port` is omitted: show the container's
 * open in-jail listeners, prompt for the jail port (defaulting to the sole
 * obvious one), then ask whether to bind it on a DIFFERENT host port and let the
 * user type it. Returns the netcage port token (`<jail>` or `<host>:<jail>`), or
 * undefined on cancel / a bad entry (reported). Requires a TTY.
 */
function promptForwardPort(ref: string): string | undefined {
	if (!process.stdin.isTTY) {
		process.stderr.write(
			'anon-pi: no TTY. Pass the port explicitly, e.g. `anon-pi forward --port 3001`.\n',
		);
		return undefined;
	}
	const listeners = queryNetcagePorts(ref);
	const open = forwardablePorts(listeners);
	process.stderr.write(`  in-jail listeners: ${formatPortsHint(listeners)}\n`);

	const def = open.length === 1 ? String(open[0]) : undefined;
	const jailAns = promptLine(
		`  jail port to forward${def ? ` [${def}]` : ''}: `,
	);
	const jailStr =
		jailAns === undefined || jailAns.trim() === '' ? def : jailAns.trim();
	if (jailStr === undefined) {
		process.stderr.write('anon-pi: no port given; nothing forwarded.\n');
		return undefined;
	}

	const hostAns = promptLine(
		`  host port (Enter for same as jail, or type a different one): `,
	);
	const hostStr = hostAns === undefined ? '' : hostAns.trim();
	const token = hostStr === '' ? jailStr : `${hostStr}:${jailStr}`;
	try {
		return parsePortArg(token).raw; // validate 1..65535 + shape
	} catch (e) {
		reportAnonPiError(e);
		return undefined;
	}
}

/**
 * `anon-pi ports [<project>] [-m <machine>]`: list a running anon-pi container's
 * open in-jail TCP listeners (via `netcage ports --json`), image-independent.
 * Disambiguates the same way as forward.
 */
function runPorts(portsArgs: string[]): number {
	if (portsArgs.includes('--help') || portsArgs.includes('-h')) {
		process.stdout.write(PORTS_HELP);
		return 0;
	}
	if (!hasNetcage()) return netcageMissing();

	let cmd;
	try {
		cmd = parsePortsArgs(portsArgs);
	} catch (e) {
		return reportAnonPiError(e);
	}

	const machine = resolveVerbMachine(cmd.machine, cmd.machineExplicit);
	const target = resolveForwardTarget(machine, cmd.project, 'ports');
	if (target === undefined) return 1;

	const listeners = queryNetcagePorts(target.ref);
	if (listeners.length === 0) {
		process.stdout.write(
			`${target.name}: no in-jail TCP listeners detected ` +
				`(the server may not be up yet, or netcage < 0.9.0).\n`,
		);
		return 0;
	}
	process.stdout.write(`${target.name}: in-jail TCP listeners\n`);
	for (const l of listeners) {
		const scope = l.loopbackOnly ? 'loopback' : 'all-interfaces';
		const note = l.port === 53 && l.loopbackOnly ? '  (netcage DNS)' : '';
		process.stdout.write(`  ${l.address}:${l.port}\t${scope}${note}\n`);
	}
	return 0;
}

/** Resolve the machine a verb targets: explicit -m wins, else config.defaultMachine. */
function resolveVerbMachine(machine: string, explicit: boolean): string {
	if (explicit) return machine;
	const config = readJsonConfig(envFromProcess(process.env));
	return config.defaultMachine ?? DEFAULT_MACHINE;
}

/** The shared "netcage not on PATH" error (exit 1). */
function netcageMissing(): number {
	process.stderr.write(
		'anon-pi: `netcage` not found on PATH. anon-pi is a launcher for netcage; install it first\n' +
			'(https://github.com/wighawag/netcage). Linux only.\n',
	);
	return 1;
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

/**
 * Best-effort: resolve a RESUME-family launch's session cwd from the host
 * session store, so the CLI can cd there (intent.sessionCwd) and pi resumes in
 * place instead of prompting to fork. Globs the machine's sessions dir for a
 * file whose name carries `<id>` (pi names them `<ts>_<id>.jsonl`), reads the
 * HEADER line, and returns its recorded cwd (pure sessionHeaderCwd). Returns
 * undefined on any miss (no id, id not found, unreadable, no cwd): the caller
 * then leaves the cwd at the projects root and lets pi decide, as before. NEVER
 * throws (a resume must not fail on a store-read hiccup).
 */
function resolveSessionCwd(
	env: AnonPiEnv,
	machine: string,
	piArgs: readonly string[] | undefined,
): string | undefined {
	const id = resumeSessionId(piArgs);
	if (id === undefined) return undefined;
	const sessionsRoot = machineSessionsDir(env, machine);
	if (!existsSync(sessionsRoot)) return undefined;
	try {
		// sessions/<slug>/<ts>_<id>.jsonl: scan each slug dir for a file whose name
		// contains the id. The id is a UUID (no path/glob metachars), so a substring
		// match is safe and cheap for the short session lists here.
		for (const slug of readdirSync(sessionsRoot, {withFileTypes: true})) {
			if (!slug.isDirectory()) continue;
			const slugDir = join(sessionsRoot, slug.name);
			for (const f of readdirSync(slugDir)) {
				if (!f.endsWith('.jsonl') || !f.includes(id)) continue;
				const header = firstLine(join(slugDir, f));
				if (header === undefined) return undefined;
				return sessionHeaderCwd(header);
			}
		}
	} catch {
		return undefined;
	}
	return undefined;
}

/** Read a file's FIRST line (up to a newline), or undefined if unreadable. */
function firstLine(path: string): string | undefined {
	try {
		const text = readFileSync(path, 'utf8');
		const nl = text.indexOf('\n');
		return nl === -1 ? text : text.slice(0, nl);
	} catch {
		return undefined;
	}
}

/** Spawn netcage with inherited stdio; propagate its exit code. */
function spawnNetcage(
	netcageArgs: string[],
	opts: {enteringJail?: boolean} = {},
): number {
	// Explain the pause on a LAUNCH: netcage sets up the jail (netns, firewall,
	// DNS, container start) BEFORE pi paints, so without this line the user sees
	// only a blinking cursor. Goes to stderr (never pollutes piped stdout), and is
	// transient (pi clears the screen when its TUI comes up). NOT printed for
	// `forward` (it attaches to an existing jail, and prints its own line).
	if (opts.enteringJail) {
		process.stderr.write(
			'anon-pi: entering the netcage jail (setting up forced-egress)\u2026\n',
		);
	}
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
