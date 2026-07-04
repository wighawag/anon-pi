// anon-pi: the PURE logic (no process spawning, no interactive I/O) so every
// decision is unit-testable. cli.ts wires this to the real filesystem + spawn.
//
// What anon-pi does (settled design):
//   - ALWAYS seed a per-workdir writable copy of the canonical anon-pi config
//     (~/.config/anon-pi/agent) into a per-session dir keyed by the workdir, and
//     mount THAT as the container's pi global (PI_CODING_AGENT_DIR). The
//     canonical config is only ever READ (at seed time), never mounted, so the
//     container cannot mutate it.
//   - Mount the workdir separately at /work (pi's cwd; the user's files land on
//     the host). A user-supplied /work/.pi/ override is just pi's own
//     project-over-global layering; anon-pi neither creates nor requires it.
//   - Open exactly ONE direct hole (--allow-direct <ANON_PI_LLM>) so pi can reach
//     a local model while all other egress stays forced through the proxy.
//   - NEVER auto-populate the canonical seed: if it is absent, error and tell the
//     user to populate it (their anon accounts / chosen skills / a valid
//     trust.json that trusts /work). anon-pi does not synthesize pi's trust.json.
//   - Session identity = the ABSOLUTE workdir path (hashed). Same folder resumes
//     the same session config+state; reseed is manual (delete the session dir).

import {existsSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

/** The container path the workdir is mounted at (pi's cwd). */
export const CONTAINER_WORKDIR = '/work';

/**
 * The jail cwd root for the projects-root launch: the projects root is mounted
 * here and a project `<name>` is `/projects/<name>` (pi keys a conversation by
 * its launch cwd, so `/projects/<name>` is the conversation key). This is the
 * new machines+projects mount, distinct from the legacy CONTAINER_WORKDIR.
 */
export const CONTAINER_PROJECTS_ROOT = '/projects';

/**
 * The jail cwd root for a `--mount <parent>` launch: the HOST parent is mounted
 * here (kept DISTINCT from /projects so the two roots never collide), and a
 * project `<name>` is `/work/<name>`. See ADR-0001 (`--mount` keeps `/work`).
 */
export const CONTAINER_MOUNT_ROOT = '/work';

/**
 * The jail cwd root for a machine (its persistent home, bind-mounted at /root).
 * A machine root has no named subfolders: only the root token `.` (a scratch pi
 * / shell at `~`) is valid. Written as `~` so it reads as "the machine home".
 */
export const CONTAINER_MACHINE_HOME = '~';

/**
 * The REAL container path the machine home is bind-mounted at (the source is
 * the host `machineHomeDir`). This is what a shell-at-`~` launch actually cwds
 * into (`-w /root`), distinct from CONTAINER_MACHINE_HOME (`~`), which is the
 * human-readable menu token. It is the parent of CONTAINER_AGENT_DIR
 * (`/root/.pi/agent`); the seed-if-fresh promotes the image's `/root` defaults +
 * pi staging into the mounted home here.
 */
export const CONTAINER_HOME_ROOT = '/root';

/**
 * The container path pi uses as its config+state home. anon-pi mounts a
 * PERSISTENT host dir here (Model B), so everything pi writes, sessions,
 * history, settings (your model choice), `pi install`ed extensions, downloaded
 * bin/fd, survives across launches. Statefulness is the default.
 */
export const CONTAINER_AGENT_DIR = '/root/.pi/agent';

/**
 * Where the image STAGES its first-launch defaults (extensions + trust.json).
 * NOT the agent dir, so it never conflicts with the persistent mount. The
 * entrypoint promotes these into the mounted agent dir only when the home is
 * FRESH (Model C seed-if-fresh).
 */
export const CONTAINER_STAGE_DIR = '/opt/anon-pi-seed/agent';

/**
 * Where anon-pi mounts the canonical models.json (from `import`) read-only, so
 * the first-launch seed can copy it into the fresh home alongside the image's
 * staged defaults. Read-only: the container never writes back to the host seed.
 */
export const CONTAINER_MODELS_SEED = '/anon-pi-seed/models.json';

/** Marker file written into the agent dir after seeding; holds the seed version. */
export const SEED_MARKER = '.anon-pi-seed';

/** The single file the host-side seed carries: pi's model/provider registry. */
export const MODELS_FILE = 'models.json';

/**
 * containerRunCmd builds the container command: on a FRESH home (no seed
 * marker), promote the image's staged defaults + the mounted models.json into
 * the persistent agent dir and stamp the marker; then exec pi. On a seeded home
 * it does nothing but exec pi, so pi's persisted state (incl. anything you
 * `pi install`ed or models pi added) is used as-is and NEVER clobbered.
 *
 * seedVersion is written into the marker so a future image can re-seed changed
 * defaults on a version bump; v1 only seeds when the marker is absent.
 */
export function containerRunCmd(seedVersion: string): string {
	const agent = CONTAINER_AGENT_DIR;
	const marker = `${agent}/${SEED_MARKER}`;
	return (
		`mkdir -p "${agent}" && ` +
		`if [ ! -f "${marker}" ]; then ` +
		// image-staged defaults (extensions, trust.json), if the image provides them
		`{ [ -d "${CONTAINER_STAGE_DIR}" ] && cp -a "${CONTAINER_STAGE_DIR}/." "${agent}/" || true; } && ` +
		// the host-imported models.json, if mounted
		`{ [ -f "${CONTAINER_MODELS_SEED}" ] && cp "${CONTAINER_MODELS_SEED}" "${agent}/${MODELS_FILE}" || true; } && ` +
		`printf '%s\\n' "${seedVersion}" > "${marker}"; ` +
		`fi && ` +
		`exec pi`
	);
}

/** The seed version anon-pi stamps when it seeds a fresh home (bump to re-seed). */
export const SEED_VERSION = '1';

/** Inputs resolved from the environment + argv, injected so this stays pure. */
export interface AnonPiEnv {
	/** $HOME (or an override) used to derive default paths. */
	home: string;
	/** socks5h proxy URL. REQUIRED (no default: the proxy is what anonymizes). */
	proxy?: string;
	/** The anon-pi home dir. Default ~/.anon-pi (NOT under ~/.config). */
	anonPiHome?: string;
	/**
	 * Projects-root override from env (ANON_PI_PROJECTS). Sits above
	 * machine.json/config.json in the projects-root chain, below the later
	 * --mount CLI override. See resolveProjectsRoot.
	 */
	projects?: string;
	/** The container image that has `pi` on PATH. REQUIRED. */
	image?: string;
	/** The RFC1918/link-local IP[:port] of the local model. REQUIRED. */
	llmDirect?: string;
	/** XDG_CONFIG_HOME, if set (used to derive the default anon-pi home). */
	xdgConfigHome?: string;
	/**
	 * Absolute path to the Dockerfile.pi that ships with anon-pi, used only to
	 * make the missing-image error's build command concrete. cli.ts resolves it
	 * from import.meta.url; when absent the message falls back to a bare
	 * `Dockerfile.pi`.
	 */
	dockerfilePath?: string;
	/**
	 * Absolute path to the shipped examples/Dockerfile.pi-webveil (pi + pi-webveil
	 * + SearXNG), used to make the missing-image error mention the fuller build.
	 */
	webveilDockerfilePath?: string;
	/** The seed version anon-pi stamps into a fresh home. Default SEED_VERSION. */
	seedVersion?: string;
}

/** A user-facing error whose message is meant to be printed verbatim (no stack). */
export class AnonPiError extends Error {}

/**
 * The verbatim guidance printed when no proxy is supplied. Kept as a single
 * source so the fail-closed path (resolveProxy) emits byte-identical
 * copy-pasteable guidance. The proxy is REQUIRED and never guessed: it is what
 * anonymizes egress (fail-closed is the anonymity invariant).
 */
export const PROXY_REQUIRED_MESSAGE =
	'anon-pi: set ANON_PI_PROXY to your socks5h proxy. anon-pi has no default:\n' +
	'the proxy is what makes the session anonymous, so it is never guessed.\n' +
	'\n' +
	'Pick the one you run (copy-paste), then re-run anon-pi:\n' +
	'\n' +
	'# Tor (system tor / Tor Browser bundle default port)\n' +
	'export ANON_PI_PROXY=socks5h://127.0.0.1:9050\n' +
	'\n' +
	'# wireproxy -> a WireGuard VPN (Mullvad, Proton, ...); use YOUR configured\n' +
	'# [Socks5] BindAddress port (1080 in wireproxy examples):\n' +
	'export ANON_PI_PROXY=socks5h://127.0.0.1:1080\n' +
	'\n' +
	'# an SSH dynamic-forward (ssh -D 1080 host) or any other socks5h endpoint\n' +
	'export ANON_PI_PROXY=socks5h://127.0.0.1:1080\n' +
	'\n' +
	'Only socks5h:// is accepted (plain socks5:// resolves DNS locally and leaks).';

/**
 * Resolve the anon-pi home dir: the dedicated, browsable workspace folder
 * (`~/.anon-pi/`, NOT under `~/.config`), holding config.json, machines/<M>/,
 * and the default global projects root. Overridable via ANON_PI_HOME.
 */
export function resolveAnonPiHome(env: AnonPiEnv): string {
	if (env.anonPiHome) return resolve(env.anonPiHome);
	return join(env.home, '.anon-pi');
}

/** A machine's directory: <home>/machines/<name> (holds machine.json + home/). */
export function machineDir(env: AnonPiEnv, name: string): string {
	return join(resolveAnonPiHome(env), 'machines', name);
}

/** A machine's persistent HOST home: <home>/machines/<name>/home (bind-mounted at /root). */
export function machineHomeDir(env: AnonPiEnv, name: string): string {
	return join(machineDir(env, name), 'home');
}

/** A machine's machine.json path: <home>/machines/<name>/machine.json. */
export function machineJsonPath(env: AnonPiEnv, name: string): string {
	return join(machineDir(env, name), 'machine.json');
}

/** The built-in default global projects root: <home>/projects. */
export function builtinProjectsRoot(env: AnonPiEnv): string {
	return join(resolveAnonPiHome(env), 'projects');
}

// --- Name validation + the "." root token ------------------------------------

/**
 * The project token meaning "the root itself": cwd `/projects` (projects root),
 * `/work` (`--mount`), or `~` (a machine home). It is NOT a valid machine or
 * project name (validateName rejects it) so a folder can never shadow it.
 */
export const ROOT_TOKEN = '.';

/**
 * Reserved names that a machine/project may NOT take (case-sensitive). Kept
 * DELIBERATELY minimal: only the two structural path tokens. `.` is the root
 * token (see ROOT_TOKEN); `..` is parent-traversal. Both are also rejected by
 * the leading-dot / `..` structural checks below, but are listed here so the
 * reserved-name concept is explicit and extendable. `--mount`'s `/work` is a
 * CONTAINER path, not a name in this namespace, so it needs no reservation.
 */
export const RESERVED_NAMES: readonly string[] = ['.', '..'];

/** What a name names, for a clear validation error. */
export type NameKind = 'machine' | 'project';

/**
 * PURE: validate a machine or project name as a safe single path segment, and
 * return it unchanged on success. Rejects (with AnonPiError):
 *   - empty
 *   - a path separator `/` or `\`, or a colon `:`
 *   - the traversal token `..` (and any leading dot, incl. `.`)
 *   - any whitespace
 *   - a reserved name (RESERVED_NAMES)
 * A valid name is thus a single folder segment safe to join under the projects
 * root or the machines dir with no traversal or drive/scheme surprises.
 */
export function validateName(name: string, kind: NameKind): string {
	const bad = (why: string): never => {
		throw new AnonPiError(
			`anon-pi: invalid ${kind} name ${JSON.stringify(name)}: ${why}. ` +
				`A ${kind} name must be a single folder segment (no / \\ : whitespace, ` +
				`no leading dot, not "..").`,
		);
	};
	if (name === '') return bad('it is empty');
	if (/[/\\:]/.test(name)) return bad('it contains / \\ or :');
	if (/\s/.test(name)) return bad('it contains whitespace');
	if (name.startsWith('.')) return bad('it starts with a dot');
	if (name === '..') return bad('it is the parent-traversal token');
	if (RESERVED_NAMES.includes(name)) return bad('it is a reserved name');
	return name;
}

/**
 * PURE: map a validated project `<name>` to its host folder under the resolved
 * projects root (the parent from resolveProjectsRoot / a `--mount` parent).
 * Validates the name (rejecting traversal) so the join stays inside the root.
 */
export function projectHostDir(projectsRoot: string, name: string): string {
	return join(projectsRoot, validateName(name, 'project'));
}

/**
 * PURE: the jail cwd for a validated project `<name>`: `/projects/<name>`. This
 * is pi's conversation key (pi keys a session by its launch cwd). Validates the
 * name. For the `--mount` root use resolveCwd('mount', name) (=> /work/<name>).
 */
export function projectContainerCwd(name: string): string {
	return `${CONTAINER_PROJECTS_ROOT}/${validateName(name, 'project')}`;
}

/** Which mounted root a launch cwds into (see the CONTAINER_* root constants). */
export type RootKind = 'projects' | 'mount' | 'machine';

/** True iff `token` is exactly the root token `.` ("the root itself"). */
export function isRootToken(token: string | undefined): boolean {
	return token === ROOT_TOKEN;
}

/** PURE: the jail cwd of a root itself: /projects, /work (mount), or ~ (machine). */
export function rootCwd(kind: RootKind): string {
	switch (kind) {
		case 'projects':
			return CONTAINER_PROJECTS_ROOT;
		case 'mount':
			return CONTAINER_MOUNT_ROOT;
		case 'machine':
			return CONTAINER_MACHINE_HOME;
	}
}

/**
 * PURE: resolve a launch's jail cwd UNIFORMLY from a `token` and its root kind.
 * The root token `.` means "the root itself" (rootCwd) in every context; any
 * other token is a project name resolved to `<root>/<name>` (validated). A
 * machine root has no named subfolders (projects live at /projects or /work,
 * never under the machine home), so a non-`.` token for a machine is rejected.
 * This is the one seam so `anon-pi --mount <p> .` and a menu "here" entry agree.
 */
export function resolveCwd(kind: RootKind, token: string): string {
	if (isRootToken(token)) return rootCwd(kind);
	if (kind === 'machine') {
		throw new AnonPiError(
			`anon-pi: a machine root takes only "${ROOT_TOKEN}" (the machine home ${CONTAINER_MACHINE_HOME}), ` +
				`not a named project ${JSON.stringify(token)}. Projects live under /projects or /work.`,
		);
	}
	return `${rootCwd(kind)}/${validateName(token, 'project')}`;
}

/** Parsed shape of config.json. All fields optional (a hand-edited file may omit any). */
export interface AnonPiConfig {
	/** socks5h proxy URL. */
	proxy?: string;
	/** The local-model direct target (host[:port]). */
	llm?: string;
	/** The machine bare `anon-pi` launches by default. */
	defaultMachine?: string;
	/** Override the projects root (host dir mounted at /projects). */
	projects?: string;
}

/** Parsed shape of a per-machine machine.json. All fields optional. */
export interface MachineConfig {
	/** The container image with `pi` on PATH for this machine. */
	image?: string;
	/** Per-machine projects-root override (above config, below env/--mount). */
	projects?: string;
}

/** Pick a string field from a parsed-JSON object, or undefined if absent/non-string. */
function strField(o: unknown, key: string): string | undefined {
	if (!o || typeof o !== 'object') return undefined;
	const v = (o as Record<string, unknown>)[key];
	return typeof v === 'string' ? v : undefined;
}

/**
 * PURE: parse an already-JSON-decoded config.json value into an AnonPiConfig,
 * keeping only the known string fields (defensive against a hand-edited file).
 * Tolerates undefined/null/partial input (an absent config is `{}`).
 */
export function parseConfigJson(raw: unknown): AnonPiConfig {
	const out: AnonPiConfig = {};
	const proxy = strField(raw, 'proxy');
	if (proxy !== undefined) out.proxy = proxy;
	const llm = strField(raw, 'llm');
	if (llm !== undefined) out.llm = llm;
	const defaultMachine = strField(raw, 'defaultMachine');
	if (defaultMachine !== undefined) out.defaultMachine = defaultMachine;
	const projects = strField(raw, 'projects');
	if (projects !== undefined) out.projects = projects;
	return out;
}

/**
 * PURE: parse an already-JSON-decoded machine.json value into a MachineConfig.
 * Tolerates undefined/null/partial input (an absent machine.json is `{}`).
 */
export function parseMachineJson(raw: unknown): MachineConfig {
	const out: MachineConfig = {};
	const image = strField(raw, 'image');
	if (image !== undefined) out.image = image;
	const projects = strField(raw, 'projects');
	if (projects !== undefined) out.projects = projects;
	return out;
}

/** A non-empty (after-trim) string, or undefined. */
function nonEmpty(v: string | undefined): string | undefined {
	return v && v.trim() !== '' ? v.trim() : undefined;
}

/**
 * PURE: resolve the projects root (the host dir mounted at /projects) with the
 * decided precedence, highest first:
 *   --mount (CLI) > env ANON_PI_PROJECTS > machine.json.projects >
 *   config.json.projects > built-in <home>/projects
 * This task delivers the config/env/machine layers; `mountParent` is the
 * documented top slot the later --mount CLI task threads in (pass the resolved
 * host parent). A relative override is resolved to an absolute path.
 */
export function resolveProjectsRoot(args: {
	env: AnonPiEnv;
	config?: AnonPiConfig;
	machine?: MachineConfig;
	/** The later --mount CLI override (a HOST parent path); top of the chain. */
	mountParent?: string;
}): string {
	const {env, config, machine, mountParent} = args;
	const pick =
		nonEmpty(mountParent) ??
		nonEmpty(env.projects) ??
		nonEmpty(machine?.projects) ??
		nonEmpty(config?.projects);
	if (pick !== undefined) return resolve(pick);
	return builtinProjectsRoot(env);
}

/**
 * PURE: resolve the proxy with env-over-config precedence, REQUIRED /
 * fail-closed. Throws AnonPiError with the verbatim PROXY_REQUIRED_MESSAGE when
 * neither env nor config supplies a non-empty proxy (never a guessed default:
 * fail-closed is the anonymity invariant).
 */
export function resolveProxy(args: {
	config?: AnonPiConfig;
	env: {proxy?: string};
}): string {
	const pick = nonEmpty(args.env.proxy) ?? nonEmpty(args.config?.proxy);
	if (pick === undefined) throw new AnonPiError(PROXY_REQUIRED_MESSAGE);
	return pick;
}

/**
 * PURE: resolve the local-model direct target with env-over-config precedence.
 * Unlike the proxy this is NOT fail-closed here (a launch with no local model
 * is a later decision); returns undefined when neither supplies one.
 */
export function resolveLlm(args: {
	config?: AnonPiConfig;
	env: {llmDirect?: string};
}): string | undefined {
	return nonEmpty(args.env.llmDirect) ?? nonEmpty(args.config?.llm);
}

// --- The per-machine RunPlan resolver ----------------------------------------
//
// The heart of the machines+projects rework: given a resolved launch intent
// (machine + mode + project token + the forced-egress inputs), compose the
// netcage argv for every mode, ALWAYS carrying the two invariant mounts
// (<home>:/root, <projects-root>:/projects) and the forced-egress flags
// (--proxy + exactly one --allow-direct). PURE: no spawn, no fs.
//
// This REPLACED the old per-workdir buildRunPlan's shape with a per-machine one.

/** A resolved machine: its host home (bind-mounted at /root) + its image. */
export interface Machine {
	/** The machine's name (already validated by validateName elsewhere). */
	name: string;
	/** The persistent HOST home dir (machineHomeDir), bind-mounted at /root. */
	home: string;
	/** The container image with `pi` on PATH for this machine. */
	image: string;
}

/**
 * What a launch runs. `menu` is the BARE launch: no target is chosen yet, so no
 * netcage argv is composed (the host-side TUI picks a project/shell, THEN a
 * fresh intent is resolved into a launch plan). `pi` runs pi (optionally with
 * forwarded args); `shell` runs bash (the project-hopper, since pi cannot cd).
 */
export type LaunchMode = 'menu' | 'pi' | 'shell';

/**
 * A parsed launch intent, injected so the resolver stays pure. The proxy + the
 * direct-hole llm are threaded in RESOLVED (via resolveProxy/resolveLlm); the
 * resolver re-asserts them non-empty so a plan can NEVER be produced without the
 * forced-egress flags (fail-closed is the anonymity invariant).
 */
export interface LaunchIntent {
	/** The machine to launch on (home + image). */
	machine: Machine;
	/** menu (bare) | pi | shell. */
	mode: LaunchMode;
	/**
	 * The resolved HOST projects root, bind-mounted at /projects. One of the two
	 * invariant mounts, present on every launch regardless of --mount.
	 */
	projectsRoot: string;
	/**
	 * The project token: a validated project name, the root token `.`, or
	 * undefined (shell-at-home / menu). Resolves the cwd via resolveCwd.
	 */
	project?: string;
	/**
	 * `--mount <parent>`: a resolved HOST parent path. When set it adds EXACTLY
	 * one mount (<parent>:/work) and re-roots the cwd there (/work[/<project>]);
	 * it changes nothing else (the two invariant mounts stay). Sidesteps podman
	 * mount immutability (we never remount a running box).
	 */
	mountParent?: string;
	/** Extra args forwarded to `pi` (headless/one-shot). Ignored for shell. */
	piArgs?: string[];
	/**
	 * `--keep`: omit `--rm` so the container is left KEPT (its filesystem
	 * survives the apt-install/re-enter flow). Default (false) => `--rm`
	 * (throwaway); the machine home persists regardless (it is a host mount).
	 */
	keep?: boolean;
	/** The resolved socks5h proxy (REQUIRED; the resolver fails closed without it). */
	proxy: string;
	/** The resolved local-model direct target (REQUIRED: the one --allow-direct hole). */
	llmDirect: string;
	/**
	 * The host models.json to mount read-only for the first-launch seed, keyed to
	 * THIS machine (e.g. <machine-dir>/models.json). Omitted => no seed mount (pi
	 * starts with no models; you add them in-session).
	 */
	modelsSeed?: string;
	/** The seed version stamped into a fresh home's marker. Default SEED_VERSION. */
	seedVersion?: string;
}

/**
 * The resolved launch plan. A discriminated union so the BARE `menu` mode is a
 * distinct, argv-less marker (the host-side TUI runs first) while every real
 * launch carries a composed netcage argv. The forced-egress invariant is
 * asserted on the `launch` variant's netcageArgs by construction.
 */
export type LaunchPlan =
	| {
			/** Bare launch: run the host-side menu, then re-resolve into a launch. */
			kind: 'menu';
			machine: Machine;
	  }
	| {
			kind: 'launch';
			machine: Machine;
			/** The jail cwd (`-w`): /projects[/<p>], /work[/<p>] (--mount), or /root (shell ~). */
			cwd: string;
			/** True when the machine home is fresh (informational; the seed is marker-guarded). */
			fresh: boolean;
			/** The argv passed to `netcage` (after the `netcage` program name). */
			netcageArgs: string[];
	  };

// --- Grammar A: the pure argv -> ParsedLaunch parser -------------------------
//
// A bare positional is a PROJECT; `-m` picks the machine. The CLI (cli.ts)
// combines the ParsedLaunch with config/machine reads (proxy, llm, image, home,
// projects root) into a LaunchIntent and runs resolveRunPlan. Kept PURE (argv
// in -> struct out, or AnonPiError) so parsing + the reserved-name guard are
// unit-testable; the CLI stays thin I/O.

/** The machine bare `anon-pi` launches when no `-m` and no config default. */
export const DEFAULT_MACHINE = 'default';

/**
 * A parsed grammar-A launch. `mode` is `menu` when no project/shell target was
 * chosen (bare `anon-pi`, or `-m <machine>` / `--mount <parent>` with no
 * project): the CLI runs the host-side menu. `pi`/`shell` carry the chosen
 * target. `project` is a validated project name, the `.` root token, or
 * undefined (menu / shell-at-home). `mountParent` is the `--mount` HOST parent
 * (a path, NOT a name-namespaced token). `keep` is `--keep` (default false =>
 * throwaway `--rm`). `piArgs` are the trailing tokens forwarded to pi (pi mode
 * only; undefined otherwise).
 */
export interface ParsedLaunch {
	mode: LaunchMode;
	machine: string;
	/**
	 * True iff `-m`/`--machine` was given explicitly (so the CLI can let an
	 * explicit `-m default` win over `config.defaultMachine`, rather than treat
	 * the DEFAULT_MACHINE value as "unset").
	 */
	machineExplicit: boolean;
	project?: string;
	mountParent?: string;
	keep: boolean;
	piArgs?: string[];
}

/**
 * PURE: parse grammar A into a ParsedLaunch. Consumes the anon-pi flags
 * (`-m <machine>`, `--shell`, `--mount <parent>`, `--keep`/`--rm`) LEFT of the
 * project positional; the FIRST bare positional is the project (`.` allowed as
 * the root token). In pi mode every token AFTER the project is forwarded to pi
 * verbatim (so `anon-pi recon -p '...'` works) — anon-pi flags must come before
 * the project. In shell/menu mode a stray extra positional is an error (bash has
 * no forwarded-args grammar; the menu takes no project).
 *
 * Validates the project name and the `-m` machine name via validateName (the
 * reserved-name guard); `--mount <parent>` is a HOST path in its own namespace,
 * distinct from the project-name namespace (NAME vs `--mount` exclusivity), so
 * it is NOT name-validated here. Throws AnonPiError for an unknown option, a
 * missing `-m`/`--mount` argument, a contradictory `--keep --rm`, or a bad name.
 */
export function parseLaunchArgs(args: readonly string[]): ParsedLaunch {
	let machine = DEFAULT_MACHINE;
	let machineSet = false;
	let shell = false;
	let mountParent: string | undefined;
	let keepSeen = false;
	let rmSeen = false;
	let project: string | undefined;
	let piArgs: string[] | undefined;

	const fail = (msg: string): never => {
		throw new AnonPiError(`anon-pi: ${msg}\nRun \`anon-pi --help\`.`);
	};

	let i = 0;
	for (; i < args.length; i++) {
		const a = args[i];
		if (a === '-m' || a === '--machine') {
			const v = args[++i];
			if (v === undefined) fail(`${a} needs a machine name`);
			machine = validateName(v as string, 'machine');
			machineSet = true;
			continue;
		}
		if (a === '--shell') {
			shell = true;
			continue;
		}
		if (a === '--mount') {
			const v = args[++i];
			if (v === undefined) fail('--mount needs a HOST parent path');
			mountParent = v as string;
			continue;
		}
		if (a === '--keep') {
			keepSeen = true;
			continue;
		}
		if (a === '--rm') {
			rmSeen = true;
			continue;
		}
		if (a === '.') {
			// the root token is a valid project positional (not a name).
			project = ROOT_TOKEN;
			i++;
			break;
		}
		if (a.startsWith('-')) {
			fail(`unknown option: ${a}`);
		}
		// the first bare positional is the project.
		project = validateName(a, 'project');
		i++;
		break;
	}

	if (keepSeen && rmSeen) {
		fail('--keep and --rm are contradictory (pick one; --rm is the default)');
	}

	// tokens remaining after the project.
	const rest = args.slice(i);
	if (shell) {
		if (rest.length > 0) {
			fail(
				`--shell takes at most one project, got extra: ${rest.join(' ')} ` +
					'(a shell forwards no args; run pi from inside it instead)',
			);
		}
		return {
			mode: 'shell',
			machine,
			machineExplicit: machineSet,
			project,
			mountParent,
			keep: keepSeen,
		};
	}

	if (project === undefined) {
		// no project + no --shell: the menu (bare, or -m/--mount with no project).
		if (rest.length > 0) fail(`unexpected argument: ${rest[0]}`);
		return {
			mode: 'menu',
			machine,
			machineExplicit: machineSet,
			project: undefined,
			mountParent,
			keep: keepSeen,
		};
	}

	// pi mode: every token after the project is forwarded to pi verbatim.
	if (rest.length > 0) piArgs = rest.slice();
	return {
		mode: 'pi',
		machine,
		machineExplicit: machineSet,
		project,
		mountParent,
		keep: keepSeen,
		piArgs,
	};
}

/**
 * PURE: resolve a LaunchIntent into a LaunchPlan, composing the netcage argv for
 * every mode. Never spawns, never touches the filesystem: `homeFresh` reports
 * whether the machine home has been seeded (so `fresh` is known) and is the only
 * capability injected.
 *
 * Invariants held on EVERY composed argv:
 *   - the two mounts <home>:/root and <projectsRoot>:/projects, always;
 *   - --mount adds EXACTLY <parent>:/work and re-roots cwd, nothing else;
 *   - --proxy <p> + exactly one --allow-direct <llm> (forced egress, fail-closed);
 *   - --rm by default, omitted only under --keep.
 *
 * Throws AnonPiError (a plan is NEVER produced) when the image, the machine
 * home, the proxy, or the direct-hole llm is missing.
 */
export function resolveRunPlan(
	intent: LaunchIntent,
	homeFresh: (machineHome: string) => boolean,
): LaunchPlan {
	const {machine, mode, projectsRoot, project, mountParent} = intent;

	// Forced egress FIRST, on every path incl. the menu marker: a plan can never
	// be produced without the proxy + the one direct hole (fail-closed).
	const proxy = nonEmpty(intent.proxy);
	if (proxy === undefined) throw new AnonPiError(PROXY_REQUIRED_MESSAGE);
	const llm = nonEmpty(intent.llmDirect);
	if (llm === undefined) {
		throw new AnonPiError(
			'anon-pi: no local-model direct target: set ANON_PI_LLM (or config.llm) to the ' +
				'RFC1918/link-local IP[:port] of the local model. It is the ONE direct hole; ' +
				'all other egress stays forced through the proxy.',
		);
	}
	if (nonEmpty(machine.image) === undefined) {
		throw new AnonPiError(
			`anon-pi: machine ${JSON.stringify(machine.name)} has no image. Set one with ` +
				'`anon-pi machine set-image` or in its machine.json.',
		);
	}
	if (nonEmpty(machine.home) === undefined) {
		throw new AnonPiError(
			`anon-pi: machine ${JSON.stringify(machine.name)} has no resolved home dir.`,
		);
	}

	// Bare launch: defer to the host-side menu; compose no argv yet (but the
	// forced-egress checks above have already run, so a menu is never a way to
	// slip past the proxy requirement).
	if (mode === 'menu') {
		return {kind: 'menu', machine};
	}

	const mounted = nonEmpty(mountParent) !== undefined;
	// Which root the cwd resolves under: /work when --mount, else /projects.
	const rootKind: RootKind = mounted ? 'mount' : 'projects';

	// cwd: shell with no project sits at the machine home (/root); otherwise the
	// project token (a name or `.`) resolves under the active root uniformly.
	const cwd =
		project === undefined ? CONTAINER_HOME_ROOT : resolveCwd(rootKind, project);

	const fresh = homeFresh(machine.home);
	const seedVersion = intent.seedVersion ?? SEED_VERSION;
	const directTarget = hostPortKey(llm);
	const modelsSeed = nonEmpty(intent.modelsSeed);

	// Interactive modes (interactive pi, shell) need a TTY; a HEADLESS pi run
	// (`<project> <pi-args…>`) must work WITHOUT one, so `-it` is omitted there
	// (podman fails to allocate a TTY on a non-tty stdin). The CLI's broader
	// no-TTY discipline (erroring when an interactive mode has no TTY) is a later
	// task; here the argv simply omits -it for the one headless shape.
	const headless = mode === 'pi' && !!intent.piArgs && intent.piArgs.length > 0;

	const netcageArgs: string[] = ['run'];
	// --rm by DEFAULT (throwaway); --keep leaves the container kept.
	if (intent.keep !== true) netcageArgs.push('--rm');
	// Forced egress: the proxy + the ONE direct hole. Never omitted.
	netcageArgs.push('--proxy', proxy, '--allow-direct', directTarget);
	if (!headless) netcageArgs.push('-it');
	// The TWO invariant mounts, ALWAYS.
	netcageArgs.push('-v', `${machine.home}:${CONTAINER_HOME_ROOT}`);
	netcageArgs.push('-v', `${projectsRoot}:${CONTAINER_PROJECTS_ROOT}`);
	// --mount adds EXACTLY the one parent mount at /work (distinct from /projects,
	// so the two roots never collide). Nothing else changes.
	if (mounted) {
		netcageArgs.push('-v', `${mountParent}:${CONTAINER_MOUNT_ROOT}`);
	}
	// The generated models.json read-only for the first-launch seed, when present.
	if (modelsSeed !== undefined) {
		netcageArgs.push('-v', `${modelsSeed}:${CONTAINER_MODELS_SEED}:ro`);
	}
	// The jail cwd.
	netcageArgs.push('-w', cwd);
	// The image, then the command: a marker-guarded seed-if-fresh then the tool.
	// pi (with forwarded args) for pi mode; bash for a shell. The seed shape is
	// containerRunCmd re-pointed at the machine home (/root), so a fresh machine
	// home gets the image's staged defaults + models.json once.
	netcageArgs.push(machine.image);
	if (mode === 'shell') {
		// A jailed bash: seed-if-fresh (so a fresh home still gets .bashrc etc.),
		// then exec bash.
		netcageArgs.push('sh', '-c', containerSeedThen(seedVersion, 'exec bash'));
	} else if (intent.piArgs && intent.piArgs.length > 0) {
		// Forward args: seed-if-fresh, then exec pi with the args. The args are the
		// shell's positional argv ($@) so they are forwarded verbatim (no re-quote).
		netcageArgs.push(
			'sh',
			'-c',
			containerSeedThen(seedVersion, 'exec pi "$@"'),
			'pi',
			...intent.piArgs,
		);
	} else {
		// Interactive pi: seed-if-fresh, then exec pi.
		netcageArgs.push('sh', '-c', containerSeedThen(seedVersion, 'exec pi'));
	}

	return {kind: 'launch', machine, cwd, fresh, netcageArgs};
}

/**
 * The marker-guarded seed-if-fresh prefix (reused across pi/bash), followed by
 * the given exec. On a FRESH machine home (no `.anon-pi-seed` marker under
 * /root/.pi/agent) it promotes the image's staged pi defaults
 * (/opt/anon-pi-seed/agent) + the mounted models.json into the home and stamps
 * the marker; on a seeded home it does nothing. Then it runs `exec`. This is
 * `containerRunCmd`'s shape (already /root-pointed), generalised over the tool.
 */
function containerSeedThen(seedVersion: string, exec: string): string {
	const agent = CONTAINER_AGENT_DIR;
	const marker = `${agent}/${SEED_MARKER}`;
	return (
		`mkdir -p "${agent}" && ` +
		`if [ ! -f "${marker}" ]; then ` +
		`{ [ -d "${CONTAINER_STAGE_DIR}" ] && cp -a "${CONTAINER_STAGE_DIR}/." "${agent}/" || true; } && ` +
		`{ [ -f "${CONTAINER_MODELS_SEED}" ] && cp "${CONTAINER_MODELS_SEED}" "${agent}/${MODELS_FILE}" || true; } && ` +
		`printf '%s\\n' "${seedVersion}" > "${marker}"; ` +
		`fi && ` +
		`${exec}`
	);
}

// --- The run-vs-start decision for kept (netcage.managed) containers ---------
//
// The exploratory `--keep` flow: run a container, tweak the system (apt install
// ...), quit, then re-enter with the SAME launch and RESUME it via `netcage
// start` (the container filesystem survives). Throwaway (`--rm`) is the default
// and is ALWAYS a fresh `run`.
//
// This module owns only the PURE decision: given a resolved LaunchIntent and a
// SUPPLIED listing of kept containers, decide `start` (a matching kept container
// is present) vs `run` without `--rm` (absent). The netcage QUERY (how to ask
// netcage for its labelled containers, e.g. `netcage ps` filtered by the
// `netcage.managed` label) is the CLI's impure job; the pure rule receives its
// RESULT (the listing) so the decision stays unit-testable. anon-pi invents NO
// registry file: netcage's `netcage.managed` label IS the record.

/**
 * A kept `netcage.managed` container, as the CLI's netcage query surfaces it to
 * the pure decision. Only the two fields the DECISION needs are typed:
 *   - `key`: the anon-pi launch-identity key (keptContainerKey) the CLI stamped
 *     onto the container at `run` time (a netcage label / container name) and
 *     reads back from the label; this is what a launch matches against.
 *   - `ref`: how to address the container for `netcage start` (its id or name).
 * The CLI is free to carry more; the pure rule reads only these.
 */
export interface KeptContainer {
	/** The anon-pi launch-identity key stamped on the container (keptContainerKey). */
	key: string;
	/** The container ref (id or name) to pass to `netcage start`. */
	ref: string;
}

/**
 * The run-vs-start decision. `run` = `netcage run` a fresh container (WITHOUT
 * `--rm` under `--keep`, so it is left kept; the run argv itself is
 * resolveRunPlan's job). `start` = `netcage start <ref>` an existing kept
 * container whose identity matches this launch.
 */
export type RunVsStart = {action: 'run'} | {action: 'start'; ref: string};

/**
 * PURE: the launch-identity match key for a kept container, derived ENTIRELY
 * from the (machine, projects-root, project) identity (ADR-0002). It is what
 * decides whether an existing kept `netcage.managed` container IS the one a
 * `--keep` launch should resume.
 *
 * The fields, and why each is load-bearing:
 *   - `machine.name`: a kept container mounts THIS machine's home at /root; a
 *     same-project container on another machine is a different environment.
 *   - `projectsRoot`: the host dir mounted at /projects; two launches with the
 *     same project name but different roots are different working trees.
 *   - `mountParent` (or '' when absent): `--mount` re-roots into a DIFFERENT
 *     host parent at /work, so a `--mount` launch is a distinct identity from
 *     the projects-root launch of the same name.
 *   - the resolved container `cwd`: this already encodes the project token
 *     (`/projects/<p>`, `/work/<p>`, `.` -> a root, or /root for a bare shell)
 *     AND which root it sits under, so it is pi's conversation key too. Using
 *     the cwd keeps the container identity aligned with the conversation the
 *     kept container hosts.
 *
 * DELIBERATELY EXCLUDED (not part of identity): `--keep`/`--rm` (the throwaway
 * choice for THIS run), the proxy + the direct-hole llm (forced-egress inputs),
 * forwarded pi args, and the seed. Two launches that differ only in those must
 * resolve to the SAME kept container.
 *
 * The key is a single opaque string (a `\n`-joined, field-tagged record) so the
 * CLI can stamp it verbatim onto a netcage label and match on string equality;
 * its internal shape is not a contract (compare only keys this function makes).
 */
export function keptContainerKey(intent: LaunchIntent): string {
	const {machine, projectsRoot, project, mountParent} = intent;
	const mounted = nonEmpty(mountParent) !== undefined;
	const rootKind: RootKind = mounted ? 'mount' : 'projects';
	// The same cwd resolution resolveRunPlan uses, so the key names the exact
	// container a matching launch would run in (its conversation key).
	const cwd =
		project === undefined ? CONTAINER_HOME_ROOT : resolveCwd(rootKind, project);
	return [
		`machine=${machine.name}`,
		`projectsRoot=${projectsRoot}`,
		`mountParent=${nonEmpty(mountParent) ?? ''}`,
		`cwd=${cwd}`,
	].join('\n');
}

/**
 * PURE: decide run-vs-start for a launch given a SUPPLIED listing of kept
 * `netcage.managed` containers (the CLI's netcage query result).
 *
 *   - `--rm` (throwaway, `intent.keep !== true`): ALWAYS a fresh `run`. The
 *     listing is NOT consulted (a throwaway launch never resumes a kept box).
 *   - `--keep`: a kept container whose `key` equals this launch's
 *     keptContainerKey is present -> `start` it (by its `ref`); else -> `run`
 *     (resolveRunPlan leaves it kept because `--keep` omits `--rm`).
 *
 * Never spawns, never queries netcage: the listing is injected, so the whole
 * decision is a pure function of (intent, listing).
 */
export function resolveRunVsStart(
	intent: LaunchIntent,
	kept: readonly KeptContainer[],
): RunVsStart {
	// Throwaway short-circuit: a `--rm` launch is always a fresh run and never
	// consults the listing (it must not resume a kept container).
	if (intent.keep !== true) return {action: 'run'};

	const want = keptContainerKey(intent);
	const match = kept.find((c) => c.key === want);
	return match ? {action: 'start', ref: match.ref} : {action: 'run'};
}

// --- The bare-launch menu: choice-list + per-machine project-usage record ----
//
// anon-pi's bare launch shows a HOST-side arrow-key menu of a machine's
// projects BEFORE any jail runs. This module owns only the PURE data the menu
// renders; the CLI reads the real dirs (the projects root + each machine home's
// sessions dir) and renders the raw-mode TUI (the cli-bare-launch-menu-tui
// task). Everything here takes SUPPLIED listings so it stays unit-testable.
//
// Conversations are per-machine (each machine's home keeps its own pi
// sessions), but project FILES are global (the same folder is shared across
// machines). pi keys a session by its launch cwd, so a project used on a machine
// leaves a session dir at machines/<M>/home/.pi/agent/sessions/<slug>/, where
// <slug> is pi's cwd convention over /projects/<name> (projectSessionSlug),
// machine-invariant. "Used on" is therefore DERIVED from which machine homes
// contain that session dir - no marker file.

/**
 * PURE: the pi session-dir slug for a project, i.e. pathSlug of its jail cwd
 * `/projects/<name>`. Because the cwd is the SAME on every machine (files are
 * global, the projects root is mounted at /projects everywhere), this slug is
 * MACHINE-INVARIANT: the same shared project is recognised in each machine's
 * sessions dir. Validates the name (rejecting traversal) as projectContainerCwd
 * does. e.g. `alpha` -> `--projects-alpha--`.
 */
export function projectSessionSlug(name: string): string {
	return pathSlug(projectContainerCwd(name));
}

/**
 * The pure choice-list the bare-launch menu renders. `projects` are the
 * folder-safe project names (sorted, case-insensitive) offered as pi launches;
 * `here` is the `.` root token (a scratch pi at the root itself); `canNew` /
 * `canShell` gate the `+ new project…` and `shell` affordances. It carries NO
 * usage annotation (that is deriveProjectUsage, keyed by project name), so a
 * caller can render the list alone or joined with usage.
 */
export interface MenuChoiceList {
	/** The folder-safe project names, sorted case-insensitively for a stable menu. */
	projects: string[];
	/** The `.` "here" entry: a scratch pi at the root itself (ROOT_TOKEN). */
	here: string;
	/** Whether the `+ new project…` affordance is offered (always true today). */
	canNew: boolean;
	/** Whether the `shell` affordance is offered (always true today). */
	canShell: boolean;
}

/**
 * PURE: build the menu choice-list from a SUPPLIED projects-root listing (the
 * CLI's real `readdir` of the projects root). Entries that are not folder-safe
 * project names (dotfiles like `.git`, `..`, path-separator names, whitespace,
 * reserved tokens) are DROPPED silently: they can never be a valid project
 * launch (validateName would reject them), and the `.` root is the separate
 * `here` entry, not a listed project. The surviving names are sorted
 * case-insensitively so the menu order is stable regardless of dir-read order.
 *
 * `canNew` / `canShell` default TRUE (both affordances are always offered
 * today); they are fields so a later policy can gate them without a signature
 * change. An empty projects root still offers here / new / shell.
 */
export function buildMenuChoiceList(args: {
	projects: readonly string[];
	canNew?: boolean;
	canShell?: boolean;
}): MenuChoiceList {
	const projects = args.projects.filter(isProjectName).sort((a, b) => {
		const la = a.toLowerCase();
		const lb = b.toLowerCase();
		if (la < lb) return -1;
		if (la > lb) return 1;
		// Case-insensitive ties keep a deterministic order via the raw compare.
		return a < b ? -1 : a > b ? 1 : 0;
	});
	return {
		projects,
		here: ROOT_TOKEN,
		canNew: args.canNew ?? true,
		canShell: args.canShell ?? true,
	};
}

/** True iff `name` is a folder-safe project name (validateName would accept it). */
function isProjectName(name: string): boolean {
	try {
		validateName(name, 'project');
		return true;
	} catch {
		return false;
	}
}

/**
 * A per-machine session-dir listing: for each machine name, the slugs present
 * under machines/<M>/home/.pi/agent/sessions/. The CLI derives this by reading
 * each machine home's sessions dir; the pure derivation takes it as input. Only
 * the project session slugs (projectSessionSlug) are matched; any other slug
 * (e.g. a `.`/`~`/`--mount` scratch session) is simply not a project so it does
 * not appear in the usage record.
 */
export type SessionDirListing = Record<string, readonly string[]>;

/** The usage record for ONE project: which machines used it + a current-new flag. */
export interface ProjectUsage {
	/** The project name (as supplied; validated). */
	project: string;
	/**
	 * The machine names whose home contains this project's session dir, sorted
	 * (a stable, machine-invariant "used on" list derived from session presence).
	 */
	machines: string[];
	/**
	 * True when the CURRENT machine has NO session dir for this project yet (it is
	 * new for this machine, even if other machines have used the shared files).
	 */
	currentMachineIsNew: boolean;
}

/**
 * PURE: derive the per-machine project-usage record from SUPPLIED session-dir
 * presence (no marker file). For each supplied project, in the SUPPLIED order,
 * it reports which machines' homes contain that project's (machine-invariant)
 * session slug, and whether the CURRENT machine is new for it.
 *
 * The project ORDER is preserved (the caller orders the menu, e.g. via
 * buildMenuChoiceList); only the per-project `machines` list is sorted, so the
 * "used on" annotation is stable. Validates each project name (rejecting
 * traversal) via projectSessionSlug.
 */
export function deriveProjectUsage(args: {
	projects: readonly string[];
	currentMachine: string;
	sessions: SessionDirListing;
}): ProjectUsage[] {
	const {projects, currentMachine, sessions} = args;
	const machineNames = Object.keys(sessions);
	return projects.map((project) => {
		const slug = projectSessionSlug(project);
		const machines = machineNames
			.filter((m) => (sessions[m] ?? []).includes(slug))
			.sort();
		const currentMachineIsNew = !(sessions[currentMachine] ?? []).includes(
			slug,
		);
		return {project, machines, currentMachineIsNew};
	});
}

/**
 * Encode an absolute path into a directory name using pi's OWN convention (see
 * pi coding-agent session-manager: `--${cwd without leading slash, / \ : -> -}--`),
 * so an anon-pi state dir is readable and matches pi's mental model (no opaque
 * hash). e.g. /home/u/dev/x -> --home-u-dev-x--
 */
export function pathSlug(absPath: string): string {
	return `--${absPath.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
}

/**
 * Normalise a proxy-less host:port key from an ANON_PI_LLM value or a provider
 * baseUrl, so `192.168.1.150:8080` matches `http://192.168.1.150:8080/v1`.
 * Returns `host` (no port) or `host:port`, lowercased, scheme/path stripped.
 */
export function hostPortKey(value: string): string {
	let v = value.trim();
	const scheme = v.indexOf('://');
	if (scheme >= 0) v = v.slice(scheme + 3);
	v = v.split('/')[0]; // drop path (/v1, ...)
	v = v.replace(/^[^@]*@/, ''); // drop any user:pass@
	return v.toLowerCase();
}

/**
 * The provider key anon-pi gives the single local provider it generates. A
 * neutral, host-agnostic name (matches the CONTEXT glossary's "local model"):
 * it carries NO host identity, unlike the old `import` path which kept the
 * host's own provider key.
 */
export const LOCAL_PROVIDER_NAME = 'local';

/**
 * The pi `api` dialect the generated local provider speaks. Local model servers
 * (llama.cpp, ollama, LM Studio, vLLM, ...) are overwhelmingly OpenAI-compatible
 * and serve the completions API under `/v1`, so this is the safe default for an
 * endpoint captured by `init` (there is no host models.json to copy a dialect
 * from anymore). See the ## Decisions note in the done record.
 */
export const LOCAL_PROVIDER_API = 'openai-completions';

/**
 * A benign, non-secret apiKey for the local provider (a LAN model rarely needs a
 * real key). It is one of the values pi never flags as a real secret.
 */
export const LOCAL_PROVIDER_API_KEY = 'none';

/**
 * PURE: synthesize a barebones pi `models.json` from a single `llm` endpoint
 * (a URL, `ip:port`, or bare ip). It normalises the endpoint with `hostPortKey`
 * (drops scheme/path/user:pass@, lowercases) and returns a models.json carrying
 * exactly ONE local provider pointed at that endpoint.
 *
 * This REPLACES the old `import`-from-host-models.json flow: it reads NO host pi
 * config, so no other provider, no paid API key, no session identity can leak
 * into the seed. Endpoint in -> object out; `init` / seed-if-fresh write the
 * result into the machine home.
 *
 * The baseUrl is `http://<host[:port]>/v1` (the OpenAI-compatible convention the
 * completions api uses); the api dialect + benign apiKey are the LOCAL_PROVIDER_*
 * constants.
 */
export function generateModelsJson(llmEndpoint: string): PiModelsFile {
	const hostPort = hostPortKey(llmEndpoint);
	const provider: PiProvider = {
		api: LOCAL_PROVIDER_API,
		apiKey: LOCAL_PROVIDER_API_KEY,
		baseUrl: `http://${hostPort}/v1`,
		models: [],
	};
	return {providers: {[LOCAL_PROVIDER_NAME]: provider}};
}

/**
 * A pi provider entry (as it appears under models.json `providers[name]`). Only
 * the fields anon-pi reads are typed; the rest is preserved verbatim.
 */
export interface PiProvider {
	baseUrl?: string;
	apiKey?: string;
	api?: string;
	models?: unknown[];
	[k: string]: unknown;
}

/** Parsed shape of a pi models.json (only `providers` is required). */
export interface PiModelsFile {
	providers?: Record<string, PiProvider>;
	[k: string]: unknown;
}

/**
 * Absolute path to the Dockerfile.pi that ships with anon-pi, resolved from this
 * module's location (package root, one level up from dist/anon-pi.js), or
 * undefined if it cannot be found. Used only to make the missing-image error's
 * build command concrete.
 */
export function shippedDockerfilePath(): string | undefined {
	return shippedFile('Dockerfile.pi');
}

/**
 * Absolute path to the fuller pi-webveil + SearXNG example that ships with
 * anon-pi (examples/Dockerfile.pi-webveil), or undefined if not found.
 */
export function shippedWebveilDockerfilePath(): string | undefined {
	return shippedFile(join('examples', 'Dockerfile.pi-webveil'));
}

/**
 * Resolve a file shipped in the package root, from this module's location
 * (package root is one level up from dist/anon-pi.js). Returns undefined if it
 * cannot be found or import.meta.url is unavailable.
 */
function shippedFile(rel: string): string | undefined {
	try {
		const here = dirname(fileURLToPath(import.meta.url));
		for (const p of [join(here, '..', rel), join(here, rel)]) {
			if (existsSync(p)) return p;
		}
	} catch {
		// import.meta.url unavailable (e.g. some test bundlers): fall through.
	}
	return undefined;
}

// --- The `machine {create,list,set-image,rm}` verbs (pure parts) -------------
//
// Machines are first-class: an image + a persistent host home
// (machines/<M>/{machine.json,home/}). These verbs manage them. The pure module
// owns the argv parse (a testable `machine <verb> …` grammar), the machine.json
// serialisation, and the set-image compatibility WARNING wording; the CLI does
// the fs (mkdir/write/rm), the list read, and the rm confirm/`--yes`/non-TTY
// discipline. Dispatch stays thin; every decision that CAN be pure IS.

/**
 * A parsed `machine <verb> …` command. A discriminated union so the CLI
 * dispatches on `verb` with the already-validated fields:
 *   - `create <name> [--image <ref>]`: name validated; image optional here (the
 *     CLI prompts for it when absent, on a TTY).
 *   - `list`: no args.
 *   - `set-image <name> <ref>`: name validated; the new image ref (non-empty).
 *   - `rm <name> [--yes]`: name validated; `yes` skips the confirm (the CLI
 *     still enforces the non-TTY abort when `yes` is false).
 */
export type MachineCommand =
	| {verb: 'create'; name: string; image?: string}
	| {verb: 'list'}
	| {verb: 'set-image'; name: string; image: string}
	| {verb: 'rm'; name: string; yes: boolean};

/**
 * PURE: parse the tokens AFTER `machine` into a MachineCommand. Validates the
 * machine name via validateName (the reserved-name / traversal guard) so the CLI
 * only ever joins a safe segment under the machines dir. Throws AnonPiError
 * (printed verbatim, exit 1) for an unknown/missing verb, a missing or extra
 * positional, an unknown flag, or a bad name.
 *
 * The grammar is deliberately small and flag-light (mirrors the launch grammar's
 * `--yes` / `--image` shape): `--image <ref>` on create, `--yes` on rm; no other
 * flags. This keeps `machine` a thin, predictable dispatch surface.
 */
export function parseMachineArgs(args: readonly string[]): MachineCommand {
	const fail = (msg: string): never => {
		throw new AnonPiError(
			`anon-pi: ${msg}\nRun \`anon-pi machine --help\` or \`anon-pi --help\`.`,
		);
	};

	const verb = args[0];
	if (verb === undefined) {
		fail('`machine` needs a subcommand: create | list | set-image | rm');
	}

	const rest = args.slice(1);

	if (verb === 'list') {
		if (rest.length > 0)
			fail(`machine list takes no arguments, got: ${rest.join(' ')}`);
		return {verb: 'list'};
	}

	if (verb === 'create') {
		let name: string | undefined;
		let image: string | undefined;
		for (let i = 0; i < rest.length; i++) {
			const a = rest[i];
			if (a === '--image') {
				const v = rest[++i];
				if (v === undefined) fail('--image needs an image ref');
				image = v as string;
				continue;
			}
			if (a.startsWith('-')) fail(`unknown option: ${a}`);
			if (name !== undefined)
				fail(`machine create takes one name, got extra: ${a}`);
			name = validateName(a, 'machine');
		}
		if (name === undefined) fail('machine create needs a <name>');
		return {verb: 'create', name: name as string, image: nonEmpty(image)};
	}

	if (verb === 'set-image') {
		let name: string | undefined;
		let image: string | undefined;
		for (const a of rest) {
			if (a.startsWith('-')) fail(`unknown option: ${a}`);
			if (name === undefined) {
				name = validateName(a, 'machine');
			} else if (image === undefined) {
				image = a;
			} else {
				fail(`machine set-image takes <name> <ref>, got extra: ${a}`);
			}
		}
		if (name === undefined)
			fail('machine set-image needs a <name> and an <image-ref>');
		if (nonEmpty(image) === undefined)
			fail('machine set-image needs an <image-ref>');
		return {
			verb: 'set-image',
			name: name as string,
			image: (image as string).trim(),
		};
	}

	if (verb === 'rm') {
		let name: string | undefined;
		let yes = false;
		for (const a of rest) {
			if (a === '--yes' || a === '-y') {
				yes = true;
				continue;
			}
			if (a.startsWith('-')) fail(`unknown option: ${a}`);
			if (name !== undefined)
				fail(`machine rm takes one name, got extra: ${a}`);
			name = validateName(a, 'machine');
		}
		if (name === undefined) fail('machine rm needs a <name>');
		return {verb: 'rm', name: name as string, yes};
	}

	return fail(
		`unknown machine subcommand: ${verb} (create | list | set-image | rm)`,
	);
}

/**
 * PURE: the JSON body a machine.json carries, given the pinned image (and an
 * optional per-machine projects override, preserved on a re-pin). A single
 * source so create + set-image write byte-identical, pretty-printed JSON (tab
 * indent, trailing newline) that reads cleanly when the user browses
 * ~/.anon-pi/machines/<M>/machine.json.
 */
export function serializeMachineJson(config: MachineConfig): string {
	const out: MachineConfig = {};
	if (nonEmpty(config.image) !== undefined)
		out.image = (config.image as string).trim();
	if (nonEmpty(config.projects) !== undefined)
		out.projects = (config.projects as string).trim();
	return JSON.stringify(out, null, '\t') + '\n';
}

/**
 * PURE: the compatibility WARNING `machine set-image` prints after re-pinning
 * the image. Re-pinning does NOT reseed or touch the home: the home's pi
 * extensions / downloaded bin were built against the OLD image, so a mismatched
 * new image may misbehave. The message tells the user the two remedies (re-run
 * `pi install` inside the machine, or delete the home to reseed) WITHOUT doing
 * either automatically. See the ## Decisions note (set-image warning wording).
 */
export function setImageWarning(
	name: string,
	oldImage: string | undefined,
	newImage: string,
): string {
	const from = oldImage === undefined ? '(none)' : oldImage;
	return (
		`anon-pi: re-pinned machine ${JSON.stringify(name)} image ${from} -> ${newImage}.\n` +
		'WARNING: the home was NOT reseeded. Its pi extensions and downloaded tools\n' +
		'were built for the old image; if they misbehave on the new one, re-run\n' +
		'`pi install` inside the machine, or delete + reseed the home with\n' +
		`\`anon-pi --delete-home ${name}\` (then relaunch to seed fresh).`
	);
}

/** Read the AnonPiEnv from a process env map (kept separate so tests inject one). */
export function envFromProcess(
	penv: Record<string, string | undefined>,
): AnonPiEnv {
	return {
		home: penv.HOME ?? homedir(),
		proxy: penv.ANON_PI_PROXY,
		anonPiHome: penv.ANON_PI_HOME,
		projects: penv.ANON_PI_PROJECTS,
		image: penv.ANON_PI_IMAGE,
		llmDirect: penv.ANON_PI_LLM,
		xdgConfigHome: penv.XDG_CONFIG_HOME,
		dockerfilePath: shippedDockerfilePath(),
		webveilDockerfilePath: shippedWebveilDockerfilePath(),
	};
}

/** The --help text (kept here so it is covered by the same module). */
export const HELP = `anon-pi - run pi on anonymized, jailed machines (netcage: forced egress + one direct local model)

USAGE
  anon-pi                        MENU: pick a project (pi), a shell, or a new project
  anon-pi <project>              pi in the project (${CONTAINER_PROJECTS_ROOT}/<project>); exit pi -> host
  anon-pi <project> <pi-args…>   forward args to pi (headless/one-shot; no TTY needed)
  anon-pi --shell [<project>]    a jailed bash (at ~, or cd'd into <project>) - the project-hopper
  anon-pi -m <machine> [<p>]     the same, on <machine> (its own image + home + conversations)
  anon-pi --mount <parent> [<p>] root at a HOST parent folder instead of the projects root
  anon-pi init                   onboard: verify your proxy, capture your local model, pick an image
  anon-pi machine …              manage machines (create / list / set-image / rm)

  <project>   a folder under the projects root (mounted at ${CONTAINER_PROJECTS_ROOT}; pi's cwd). \`.\` means
              the root itself (a scratch pi at ${CONTAINER_PROJECTS_ROOT}, ${CONTAINER_MOUNT_ROOT} for --mount, or ~).

  [--rm]      throwaway container this run (the DEFAULT; deleted on exit).
  [--keep]    leave the container KEPT so its filesystem survives (apt install,
              quit, re-enter). anon-pi finds it by netcage's managed label and
              \`netcage start\`s it on re-entry.

WHAT IT DOES
  Runs pi inside netcage with all web/DNS egress forced through the socks5h proxy
  (fail-closed) and ONE direct hole to your local model (ANON_PI_LLM). A MACHINE
  is an image + a persistent HOST home (bind-mounted at ${CONTAINER_HOME_ROOT}) holding your pi
  config, extensions, and conversations; the container is disposable, so \`--rm\`
  loses nothing. Files (projects) are global by default; conversations are
  per-machine. On a FRESH machine home the image's staged defaults + your
  models.json are seeded in once; after that pi owns the home. Requires \`netcage\`.

ENVIRONMENT
  ANON_PI_PROXY   (required) socks5h URL of your proxy (Tor/wireproxy/ssh -D).
                  No default: the proxy is what anonymizes, so it is never guessed.
  ANON_PI_LLM     (required) RFC1918/link-local IP[:port] of the local model
  ANON_PI_IMAGE   image with \`pi\` on PATH, used when a machine has no image set.
                  No image yet? See the README (Providing a pi image).
  ANON_PI_HOME    anon-pi workspace dir (default ~/.anon-pi; NOT under ~/.config)
  ANON_PI_PROJECTS  projects root override (host dir mounted at ${CONTAINER_PROJECTS_ROOT})

PLATFORM
  Linux only (via netcage's netns/nft jail). On macOS/Windows it works only
  inside a Linux VM, where --allow-direct to a LAN model is VM-boundary-sensitive.
`;
