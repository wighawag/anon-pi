// anon-pi: the PURE logic (no process spawning, no interactive I/O) so every
// decision is unit-testable. cli.ts wires this to the real filesystem + spawn.
//
// The model (machines + projects; see CONTEXT.md + docs/adr/0001):
//   - A MACHINE is an image + a persistent HOST home (`machines/<M>/home`),
//     bind-mounted into the jail at /root. It holds shell config, pi config +
//     extensions, and pi conversations (`~/.pi/agent/sessions/`). The container
//     is disposable; ALL valuable state is in this host home.
//   - A PROJECT is a folder under the PROJECTS ROOT, bind-mounted at /projects,
//     so a project's cwd is /projects/<name>. pi keys a conversation by its
//     launch cwd, so /projects/<name> is the conversation key (per-machine,
//     since it lives in that machine's home).
//   - TWO invariant container mounts, always: /root (the machine home) and
//     /projects (the projects root). `--mount <parent>` adds EXACTLY one more
//     mount at the DISTINCT /work and re-roots cwd there; nothing else changes,
//     so we never remount a running container.
//   - Throwaway (`--rm`) is the DEFAULT; `--keep` leaves the container kept so
//     its filesystem survives (found + resumed by netcage's `netcage.managed`
//     label via `netcage start`). The machine home persists either way.
//   - Open exactly ONE direct hole (--allow-direct <llm>) so pi can reach a
//     local model while ALL other egress stays forced through the socks5h proxy
//     (fail-closed; the proxy is REQUIRED and never guessed).
//   - Seed-if-fresh (marker-guarded, per MACHINE home): on a fresh home, promote
//     the image's /root defaults + pi staging + the generated models.json into
//     the home once, then stamp the marker and never clobber it again.
//
// This module holds every DECISION as a pure function (config load + precedence,
// machine/project resolvers, name validation, the RunPlan argv, the menu
// choice-list, project usage, the run-vs-start rule, models.json generation,
// init's proxy detect/verify decisions). cli.ts owns only the impure edges (fs,
// the interactive TUI, the netcage query, the spawn).

import {existsSync, readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

/**
 * The jail cwd root for the projects-root launch: the projects root is mounted
 * here and a project `<name>` is `/projects/<name>` (pi keys a conversation by
 * its launch cwd, so `/projects/<name>` is the conversation key). This is the
 * machines + projects mount (distinct from `--mount`'s /work).
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
 * A machine root has no named subfolders: only the root token `.` (the machine
 * home itself) is valid. Written as `~` so it reads as "the machine home".
 */
export const CONTAINER_MACHINE_HOME = '~';

/**
 * The REAL container path the machine home is bind-mounted at (the source is
 * the host `machineHomeDir`), distinct from CONTAINER_MACHINE_HOME (`~`), which
 * is the human-readable menu token. No launch cwds here by default (a bare shell
 * lands at the projects root, not the home); it is reached via `cd ~` inside the
 * jail. It is the parent of CONTAINER_AGENT_DIR (`/root/.pi/agent`); the
 * seed-if-fresh promotes the image's `/root` defaults + pi staging into the
 * mounted home here.
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

/**
 * Where anon-pi mounts the generated settings SEED (the local-model default
 * selection: defaultProvider/defaultModel/enabledModels) read-only, so the
 * first-launch seed can MERGE it into the fresh home's settings.json (never
 * clobbering image-staged packages/extensions).
 */
export const CONTAINER_SETTINGS_SEED = '/anon-pi-seed/settings.json';

/** Marker file written into the agent dir after seeding; holds the seed version. */
export const SEED_MARKER = '.anon-pi-seed';

/** The file the host-side seed carries: pi's model/provider registry. */
export const MODELS_FILE = 'models.json';

/** pi's settings file (holds defaultModel/defaultProvider/enabledModels + more). */
export const SETTINGS_FILE = 'settings.json';

/**
 * The settings SEED file anon-pi writes next to a machine (the local-model
 * selection fragment). Distinct name so it never collides with a real
 * settings.json; the seed MERGES it into the home's settings on first launch.
 */
export const SETTINGS_SEED_FILE = 'settings-seed.json';

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
	 * The host pi agent dir (PI_CODING_AGENT_DIR), used ONLY to locate the host
	 * `~/.pi/agent/models.json` that `init` reads the matching local provider
	 * from. Defaults to ~/.pi/agent. Never written.
	 */
	piAgentDir?: string;
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

/**
 * The GLOBAL local-model models.json seed: `<home>/models.json`. The local model
 * is a WORKSPACE-level thing (config.json holds ONE global `llm`, the single
 * `--allow-direct` hole shared by every machine), so its generated models.json
 * lives once at the workspace root and seeds EVERY machine's fresh home. A
 * machine may override it with its own `machines/<M>/models.json` (see
 * resolveModelsSeedPath) for the rare "this machine uses a different local
 * model" case; by default all machines share this one.
 */
export function globalModelsSeedPath(env: AnonPiEnv): string {
	return join(resolveAnonPiHome(env), MODELS_FILE);
}

/** The GLOBAL settings seed (the default-model selection): `<home>/settings-seed.json`. */
export function globalSettingsSeedPath(env: AnonPiEnv): string {
	return join(resolveAnonPiHome(env), SETTINGS_SEED_FILE);
}

/** A machine's OPTIONAL per-machine models.json override: `machines/<M>/models.json`. */
export function machineModelsSeedPath(env: AnonPiEnv, name: string): string {
	return join(machineDir(env, name), MODELS_FILE);
}

/** A machine's OPTIONAL per-machine settings seed override: `machines/<M>/settings-seed.json`. */
export function machineSettingsSeedPath(env: AnonPiEnv, name: string): string {
	return join(machineDir(env, name), SETTINGS_SEED_FILE);
}

/**
 * PURE: resolve the models.json SEED path for a machine, per-machine override
 * first, else the global one. `exists` is injected (the CLI passes existsSync)
 * so this stays pure/testable. Returns the chosen path, or undefined when
 * NEITHER exists (a machine with no local-model seed at all — pi starts with no
 * models). The precedence is: `machines/<M>/models.json` (a deliberate
 * per-machine override) > `<home>/models.json` (the global default).
 */
export function resolveModelsSeedPath(
	env: AnonPiEnv,
	machine: string,
	exists: (p: string) => boolean,
): string | undefined {
	const perMachine = machineModelsSeedPath(env, machine);
	if (exists(perMachine)) return perMachine;
	const global = globalModelsSeedPath(env);
	if (exists(global)) return global;
	return undefined;
}

/** PURE: the settings-seed path for a machine (per-machine override > global), or undefined. */
export function resolveSettingsSeedPath(
	env: AnonPiEnv,
	machine: string,
	exists: (p: string) => boolean,
): string | undefined {
	const perMachine = machineSettingsSeedPath(env, machine);
	if (exists(perMachine)) return perMachine;
	const global = globalSettingsSeedPath(env);
	if (exists(global)) return global;
	return undefined;
}

/** The sessions dirname pi keeps its per-cwd conversation dirs under (in the agent dir). */
export const SESSIONS_DIRNAME = 'sessions';

/**
 * A machine's HOST pi agent dir: the host side of the container's
 * CONTAINER_AGENT_DIR (`/root/.pi/agent`, since the home is bind-mounted at
 * /root). i.e. <machineHome>/.pi/agent. Where pi's config + sessions live.
 */
export function machineAgentDir(env: AnonPiEnv, name: string): string {
	return join(machineHomeDir(env, name), '.pi', 'agent');
}

/**
 * A machine's HOST pi sessions dir: <machineAgentDir>/sessions. Each per-cwd
 * conversation is a slug-named subdir here (projectSessionSlug for a project).
 */
export function machineSessionsDir(env: AnonPiEnv, name: string): string {
	return join(machineAgentDir(env, name), SESSIONS_DIRNAME);
}

/**
 * The HOST session dir a given project's conversation occupies in a given
 * machine's home: <machineSessionsDir>/<projectSessionSlug>. Because the slug is
 * MACHINE-INVARIANT (pi keys by the `/projects/<name>` cwd, identical on every
 * machine), the SAME shared project has this dir in each machine that used it.
 * Validates the project name (rejecting traversal) via projectSessionSlug.
 */
export function machineProjectSessionDir(
	env: AnonPiEnv,
	machine: string,
	project: string,
): string {
	return join(machineSessionsDir(env, machine), projectSessionSlug(project));
}

/** The built-in default global projects root: <home>/projects. */
export function builtinProjectsRoot(env: AnonPiEnv): string {
	return join(resolveAnonPiHome(env), 'projects');
}

// --- The destructive cleanup verbs' affected-path resolvers ------------------
//
// `--delete-home [<machine>]` and `--delete-project <project>` replace the old
// `--fresh`. This module owns only the PURE affected-path resolution (which host
// paths a delete would remove); the CLI does the confirm prompt + the actual
// `rm` (cli-delete.test.ts). Per the prd behaviour table:
//   - delete-home drops ONE machine's home (config + convos + shell env) and
//     keeps the project FILES (they live under the projects root, not the home);
//   - delete-project drops that project's FILES and its per-machine session dir
//     in EVERY machine home (the machine-invariant slug), keeping the homes.

/** The affected-path plan for `--delete-home <machine>`. */
export interface DeleteHomePlan {
	/** The machine whose home is dropped. */
	machine: string;
	/**
	 * The single dir removed: the machine's persistent HOST home
	 * (machineHomeDir). The machine dir's machine.json (its image pin) is KEPT, so
	 * the machine can be relaunched to seed a FRESH home.
	 */
	home: string;
}

/**
 * PURE: resolve the affected path for `--delete-home <machine>`: the machine's
 * HOME dir only (config + convos + shell env), NOT the whole machine dir, so the
 * image pin (machine.json) survives a re-seed. Validates the machine name
 * (rejecting traversal) via machineHomeDir's join being under a validated name;
 * we validate explicitly here so the plan itself is a safe single segment.
 */
export function resolveDeleteHome(
	env: AnonPiEnv,
	machine: string,
): DeleteHomePlan {
	validateName(machine, 'machine');
	return {machine, home: machineHomeDir(env, machine)};
}

/** The affected-path plan for `--delete-project <project>`. */
export interface DeleteProjectPlan {
	/** The project whose files + per-machine sessions are dropped. */
	project: string;
	/** The project's files: <projectsRoot>/<project> (the host folder). */
	folder: string;
	/**
	 * The per-machine session dirs for this project's (machine-invariant) slug,
	 * ONE per supplied machine, in the SUPPLIED order. The homes themselves are
	 * kept; only these slug dirs are dropped. The CLI supplies the machine names
	 * (readdir of machines/) and skips any that do not exist on disk.
	 */
	sessions: string[];
}

/**
 * PURE: resolve the affected paths for `--delete-project <project>`: the
 * project's files under the RESOLVED projects root, plus that project's session
 * dir in each SUPPLIED machine home (the machine-invariant slug). Validates the
 * project name (rejecting traversal) so both the folder join and every session
 * join stay inside their roots. The homes are NOT targeted (only the per-project
 * slug dir inside each), matching the prd behaviour table.
 */
export function resolveDeleteProject(args: {
	env: AnonPiEnv;
	project: string;
	/** The resolved projects root (host dir mounted at /projects). */
	projectsRoot: string;
	/** The machine names whose homes may hold this project's session dir. */
	machines: readonly string[];
}): DeleteProjectPlan {
	const {env, project, projectsRoot, machines} = args;
	validateName(project, 'project');
	return {
		project,
		folder: projectHostDir(projectsRoot, project),
		sessions: machines.map((m) => machineProjectSessionDir(env, m, project)),
	};
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
export const RESERVED_NAMES: readonly string[] = ['.', '..', 'pi'];
// NOTE: `pi` is reserved so the `anon-pi pi <args…>` passthrough token
// (PI_PASSTHROUGH_TOKEN) can never be shadowed by a project named `pi`.

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

/**
 * PURE: the launch cwd for a resolved (mode, rootKind, project). With a project
 * token it resolves under the active root (resolveCwd). With NO project BOTH a
 * bare `shell` and a `--session`/`--resume` pi launch start at the active root
 * (`rootCwd`): `/projects`, or `/work` under `--mount`. The shell defaults to
 * the projects root (not the machine home) because the model is project-centric
 * and files written under the home land in the machine's config home on the
 * host; a shell is the project-hopper, so `/projects` is the natural landing.
 * The machine home is one `cd ~` away for the rare case. `menu` never reaches
 * here (it is argv-less). Shared by resolveRunPlan + keptContainerKey so the run
 * cwd and the container-identity key always agree.
 */
export function launchCwd(
	_mode: LaunchMode,
	kind: RootKind,
	project: string | undefined,
): string {
	if (project !== undefined) return resolveCwd(kind, project);
	return rootCwd(kind);
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
 * PURE: expand a leading `~` / `~/` in a user-supplied HOST path to the given
 * home (`node:path.resolve` does NOT do this — it would produce a literal `~`
 * directory). Only a LEADING `~` (bare or before a separator) is expanded; a `~`
 * elsewhere is left alone. Used everywhere anon-pi takes a host path from a
 * human (the projects root, `--mount`), so `~/dev/x` means `$HOME/dev/x`.
 */
export function expandTilde(p: string, home: string): string {
	if (p === '~') return home;
	if (p.startsWith('~/') || p.startsWith('~\\')) {
		return join(home, p.slice(2));
	}
	return p;
}

/**
 * netcage's default podman graphroot (podman's global `--root`). Since netcage
 * v0.7.0 (host-identity hardening, ADR-0013) EVERY netcage podman call runs
 * against a private, username-free store at this path, NOT the operator's
 * default rootless store. So an image anon-pi builds with a plain `podman build`
 * lands in the WRONG store and `netcage run` cannot see it (it tries to pull the
 * `localhost/…` ref and fails). anon-pi must place a built image into THIS store.
 * Overridable via NETCAGE_GRAPHROOT (netcage's own test-seam env), so a caller
 * that points netcage elsewhere stays in sync.
 */
export const NETCAGE_DEFAULT_GRAPHROOT = '/var/tmp/netcage-storage';

/**
 * PURE: resolve netcage's podman graphroot the same way netcage does: the
 * NETCAGE_GRAPHROOT env override when set, else the fixed default. anon-pi builds
 * images into this store so `netcage run` finds them. This is a temporary
 * coupling to a netcage-internal path; it goes away once netcage exposes a
 * `build`/`load` verb (then anon-pi delegates to netcage instead).
 */
export function resolveNetcageGraphroot(
	penv: Record<string, string | undefined>,
): string {
	const p = penv.NETCAGE_GRAPHROOT;
	return p && p.trim() !== '' ? p.trim() : NETCAGE_DEFAULT_GRAPHROOT;
}

/**
 * PURE: resolve the projects root (the host dir mounted at /projects) with the
 * decided precedence, highest first:
 *   --mount (CLI) > env ANON_PI_PROJECTS > machine.json.projects >
 *   config.json.projects > built-in <home>/projects
 * A leading `~` in any override is expanded to $HOME; a relative override is
 * resolved to an absolute path.
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
	if (pick !== undefined) return resolve(expandTilde(pick, env.home));
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
	 * undefined (bare shell / menu). Resolves the cwd via resolveCwd; a bare
	 * shell lands at the projects root, same as the `.` token.
	 */
	project?: string;
	/**
	 * A RESUME-family launch's resolved session cwd (e.g. `/projects/test`), the
	 * cwd pi keyed the resumed session by. Set by the CLI ONLY for a NO-project
	 * `--session`/`--resume <id>` whose id it found in the host session store; it
	 * OVERRIDES the default no-project cwd (the projects root) so pi resumes in
	 * place instead of prompting to fork. Ignored when a project is given (the
	 * user is trusted) or when the id is unresolvable (pi decides, as before).
	 */
	sessionCwd?: string;
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
	/**
	 * The settings SEED to mount read-only for the first-launch seed (the
	 * local-model default selection, e.g. <machine-dir>/settings-seed.json).
	 * Omitted => no settings seed (no default model is pre-selected).
	 */
	settingsSeed?: string;
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
			/** The jail cwd (`-w`): /projects[/<p>], or /work[/<p>] (--mount). A bare shell uses the root (/projects, or /work). */
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
 * undefined (menu / bare shell, which lands at the active root). `mountParent` is the `--mount` HOST parent
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
 * pi flags anon-pi RECOGNISES in the no-project position, so `anon-pi <flag> ...`
 * forwards this flag + everything after it verbatim. Three families with three
 * no-project policies:
 *  - RESUME (`--session`/`--session-id`/`--resume`/`-r <id>`): resume ONE session
 *    in place. anon-pi resolves the session's recorded cwd from the host store
 *    and cds there (isPiResumeFlag / resumeSessionId), so pi resumes cleanly.
 *    Mirrors pi's own resume hint (`pi --session <id>`), so pasting `anon-pi
 *    --session <id>` just works.
 *  - NEEDS-PROJECT (`--fork`, `--continue`/`-c`): REFUSED without a project
 *    (isPiNeedsProjectFlag) so the (new / newest) conversation never lands in
 *    the projects root by surprise. Add a project (`.` for the root; created on
 *    demand): `anon-pi <project> --fork <id>`.
 *  - QUERY (`--list-models`/`--models`): pi prints + exits, no project relevant.
 * For arbitrary pi flags with no project (e.g. `--model x`), use the explicit
 * `anon-pi pi <args…>` passthrough instead.
 */
const PI_NO_PROJECT_FLAGS: ReadonlySet<string> = new Set([
	// session selection
	'--session',
	'--session-id',
	'--resume',
	'-r',
	'--continue',
	'-c',
	'--fork',
	// query-and-exit
	'--list-models',
	'--models',
]);

/** True iff `a` is a pi flag anon-pi accepts with no project (see PI_NO_PROJECT_FLAGS). */
function isPiNoProjectFlag(a: string): boolean {
	return PI_NO_PROJECT_FLAGS.has(a);
}

/**
 * The RESUME family: session-selecting flags that resume ONE existing session in
 * place (`--session`/`--session-id <id>`, `--resume`/`-r <id>`). With NO project,
 * anon-pi resolves the session's recorded cwd from the host session store and
 * cds THERE (setSessionCwd), so pi resumes cleanly instead of prompting to fork
 * (its guard fires when the launch cwd differs from the session cwd). With an
 * explicit project the user is trusted verbatim: anon-pi cds into that project
 * and lets pi's own fork-prompt guard a mismatch. `--continue`/`--fork` are NOT
 * here: they need a project (see PI_RESUME_NEEDS_PROJECT_FLAGS).
 */
const PI_RESUME_FLAGS: ReadonlySet<string> = new Set([
	'--session',
	'--session-id',
	'--resume',
	'-r',
]);

/**
 * Session flags that REQUIRE an explicit project with no-project: `--fork` and
 * `--continue`/`-c`. `--fork` writes a NEW session and would otherwise land it
 * silently in the projects ROOT (a surprise); `--continue`/`-c` resumes the
 * newest session for the launch cwd, so at the root it resolves ambiguously.
 * anon-pi refuses both without a project (the project may be `.` for the root,
 * and is created on demand), so where the conversation lands is always explicit.
 */
const PI_RESUME_NEEDS_PROJECT_FLAGS: ReadonlySet<string> = new Set([
	'--fork',
	'--continue',
	'-c',
]);

/** True iff `a` is a RESUME-family flag (resolve session cwd; see PI_RESUME_FLAGS). */
export function isPiResumeFlag(a: string): boolean {
	return PI_RESUME_FLAGS.has(a);
}

/** True iff `a` is a session flag that needs an explicit project (--fork/--continue). */
export function isPiNeedsProjectFlag(a: string): boolean {
	return PI_RESUME_NEEDS_PROJECT_FLAGS.has(a);
}

/**
 * PURE: the human name a --fork/--continue no-project refusal quotes. `-c` is
 * spelled as its long form `--continue` in the message (clearer guidance).
 */
export function needsProjectFlagName(flag: string): string {
	return flag === '-c' ? '--continue' : flag;
}

/**
 * PURE: the leading session-id `--fork <id>` / `--continue <id>` accepts, or
 * undefined. Used only to build a copy-pasteable "add a project" hint in the
 * refusal (`anon-pi . --fork <id>`); the id is the token right after the flag
 * when it is not itself another flag.
 */
export function resumeFlagId(piArgs: readonly string[]): string | undefined {
	if (piArgs.length < 2) return undefined;
	const id = piArgs[1];
	return id.startsWith('-') ? undefined : id;
}

/**
 * PURE: extract the session id a RESUME-family launch selects, so the CLI can
 * look its cwd up in the host session store. Scans forwarded pi args for a
 * resume flag (isPiResumeFlag) and returns the NEXT token when it is an id (not
 * another flag). Returns undefined when there is no resume flag or no id after
 * it (e.g. a bare `--resume` picker), in which case the CLI cds nowhere and pi
 * decides as today.
 */
export function resumeSessionId(
	piArgs: readonly string[] | undefined,
): string | undefined {
	if (!piArgs) return undefined;
	for (let i = 0; i < piArgs.length; i++) {
		if (isPiResumeFlag(piArgs[i])) {
			const next = piArgs[i + 1];
			if (next !== undefined && !next.startsWith('-')) return next;
			return undefined;
		}
	}
	return undefined;
}

/**
 * PURE: read a pi session's recorded cwd from its session-file HEADER line (the
 * first JSONL record, `{"type":"session","id":"…","cwd":"/projects/x"}`). This
 * is the authoritative cwd (what pi keys the conversation by), better than
 * reversing the lossy `--…--` dir slug. Returns the cwd string, or undefined if
 * the line is not the expected session header with a non-empty string cwd. The
 * caller (CLI) supplies the file's first line; this stays pure + testable.
 */
export function sessionHeaderCwd(headerLine: string): string | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(headerLine);
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== 'object') return undefined;
	const rec = parsed as Record<string, unknown>;
	if (rec.type !== 'session') return undefined;
	const cwd = rec.cwd;
	return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined;
}

/**
 * The explicit pi-passthrough token: `anon-pi pi <args…>` runs pi with the given
 * args and NO project (the general escape hatch for any pi flag). It is a
 * RESERVED project name (see RESERVED_NAMES) so a project can never shadow it.
 */
export const PI_PASSTHROUGH_TOKEN = 'pi';

/**
 * PURE: whether forwarded pi args request pi's NON-INTERACTIVE (print) mode,
 * i.e. contain `-p`/`--print`. This is the ONLY headless shape (it needs no
 * TTY): other forwarded args (`--session <id>`, `--model x`, ...) are still
 * INTERACTIVE and need a TTY + `-it`. Shared by the CLI's no-TTY discipline and
 * the RunPlan's `-it` decision so they agree.
 */
export function isHeadlessPiArgs(
	piArgs: readonly string[] | undefined,
): boolean {
	return !!piArgs && piArgs.some((a) => a === '-p' || a === '--print');
}

/**
 * Finish parsing a NO-PROJECT pi launch (`anon-pi --session <id> ...`,
 * `anon-pi --list-models`, or the explicit `anon-pi pi <args…>`): pi mode, NO
 * project (pi picks its own cwd / prints + exits), the flag(s) + rest forwarded.
 * `--shell` is incompatible (a shell forwards no pi args).
 */
function finishPiNoProjectLaunch(args: {
	machine: string;
	machineExplicit: boolean;
	mountParent?: string;
	keep: boolean;
	rm: boolean;
	shell: boolean;
	piArgs: string[];
	fail: (msg: string) => never;
}): ParsedLaunch {
	if (args.keep && args.rm) {
		args.fail(
			'--keep and --rm are contradictory (pick one; --rm is the default)',
		);
	}
	if (args.shell) {
		args.fail(
			'--shell forwards no pi args (a shell has no session/query). Drop --shell.',
		);
	}
	return {
		mode: 'pi',
		machine: args.machine,
		machineExplicit: args.machineExplicit,
		project: undefined,
		mountParent: args.mountParent,
		keep: args.keep,
		piArgs: args.piArgs,
	};
}

/**
 * PURE: parse grammar A into a ParsedLaunch. Consumes the anon-pi flags
 * (`-m <machine>`, `--shell`, `--mount <parent>`, `--keep`/`--rm`) LEFT of the
 * project positional; the FIRST bare positional is the project (`.` allowed as
 * the root token). In pi mode every token AFTER the project is forwarded to pi
 * verbatim (so `anon-pi recon -p '...'` works) — anon-pi flags must come before
 * the project. A pi session-resume flag (`--session <id>`, `--continue`,
 * `--resume`, `--fork <id>`) in the project position starts a NO-project pi
 * launch that forwards to pi (pi resolves the session + cwd itself). In
 * shell/menu mode a stray extra positional is an error (bash has no
 * forwarded-args grammar; the menu takes no project).
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
		if (a === PI_PASSTHROUGH_TOKEN) {
			// `anon-pi pi <args…>`: the explicit passthrough. Run pi with the
			// following args and NO project (pi picks its own cwd, or prints + exits
			// for a query). The general escape hatch for ANY pi flag with no project
			// (`anon-pi pi --model x`, `anon-pi pi --export out.html --session <id>`).
			return finishPiNoProjectLaunch({
				machine,
				machineExplicit: machineSet,
				mountParent,
				keep: keepSeen,
				rm: rmSeen,
				shell,
				piArgs: args.slice(i + 1),
				fail,
			});
		}
		if (isPiNoProjectFlag(a)) {
			// A pi flag that needs NO anon-pi project (RESUME family `--session <id>`/
			// `--resume <id>`; `--list-models`/`--models` print + exit). pi resolves
			// its own cwd (or just prints), so anon-pi launches pi at the projects
			// root and forwards this flag + everything after it verbatim. For the
			// RESUME family the CLI then resolves the session's recorded cwd and cds
			// there so pi resumes in place (no fork prompt). This makes pi's own "To
			// resume: pi --session <id>" hint usable as `anon-pi --session <id>`. (For
			// ARBITRARY pi flags with no project, use `anon-pi pi <args…>`.)
			//
			// --fork / --continue are REFUSED with no project: they would land a
			// (new / newest) conversation in the projects ROOT silently. Require an
			// explicit project (created on demand; `.` for the root) so where the
			// conversation lands is never a surprise.
			if (isPiNeedsProjectFlag(a)) {
				const rest = args.slice(i);
				const name = needsProjectFlagName(a);
				const id = resumeFlagId(rest);
				const example = id
					? `anon-pi <project> ${name} ${id}` +
						` (or \`anon-pi . ${name} ${id}\` for the root)`
					: `anon-pi <project> ${name} …` +
						` (or \`anon-pi . ${name} …\` for the root)`;
				fail(
					`${name} needs a project so the conversation lands in a known ` +
						`directory, not the projects root. Add one (it is created on ` +
						`demand): ${example}.`,
				);
			}
			piArgs = args.slice(i);
			project = undefined;
			i = args.length;
			return finishPiNoProjectLaunch({
				machine,
				machineExplicit: machineSet,
				mountParent,
				keep: keepSeen,
				rm: rmSeen,
				shell,
				piArgs,
				fail,
			});
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

	// A RESUME-family launch with NO project overrides the default no-project cwd
	// (the projects root) with the session's own recorded cwd, so pi resumes in
	// place. Only honoured for a projectless pi launch; a given project always
	// wins (the user is trusted, pi guards a mismatch).
	const sessionCwd = nonEmpty(intent.sessionCwd);
	const cwd =
		mode === 'pi' && project === undefined && sessionCwd !== undefined
			? sessionCwd
			: launchCwd(mode, rootKind, project);

	const fresh = homeFresh(machine.home);
	const seedVersion = intent.seedVersion ?? SEED_VERSION;
	const directTarget = hostPortKey(llm);
	const modelsSeed = nonEmpty(intent.modelsSeed);

	// Interactive modes (interactive pi, shell) need a TTY; a HEADLESS pi run
	// (`<project> <pi-args…>`) must work WITHOUT one, so `-it` is omitted there
	// (podman fails to allocate a TTY on a non-tty stdin). The CLI's broader
	// no-TTY discipline (erroring when an interactive mode has no TTY) is a later
	// task; here the argv simply omits -it for the one headless shape.
	const headless = mode === 'pi' && isHeadlessPiArgs(intent.piArgs);

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
	// The generated settings SEED (the local-model default selection) read-only,
	// when present; the seed-if-fresh MERGES it into the home's settings.json.
	const settingsSeed = nonEmpty(intent.settingsSeed);
	if (settingsSeed !== undefined) {
		netcageArgs.push('-v', `${settingsSeed}:${CONTAINER_SETTINGS_SEED}:ro`);
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
	const settings = `${agent}/${SETTINGS_FILE}`;
	// Merge the settings SEED (the local-model default selection) into the home's
	// settings.json, overwriting ONLY the three selection keys so any staged
	// packages/extensions survive. Done with a node one-liner (pi is a node app,
	// so node is on PATH). The seed path + target are shell-quoted single args.
	const mergeSettings =
		`{ [ -f "${CONTAINER_SETTINGS_SEED}" ] && node -e '` +
		`const fs=require("fs");` +
		`const seed=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));` +
		`let cur={};try{cur=JSON.parse(fs.readFileSync(process.argv[2],"utf8"))}catch(e){}` +
		`cur.defaultProvider=seed.defaultProvider;cur.defaultModel=seed.defaultModel;cur.enabledModels=seed.enabledModels;` +
		`fs.writeFileSync(process.argv[2],JSON.stringify(cur,null,"\\t")+"\\n")` +
		`' "${CONTAINER_SETTINGS_SEED}" "${settings}" || true; }`;
	return (
		`mkdir -p "${agent}" && ` +
		`if [ ! -f "${marker}" ]; then ` +
		`{ [ -d "${CONTAINER_STAGE_DIR}" ] && cp -a "${CONTAINER_STAGE_DIR}/." "${agent}/" || true; } && ` +
		`{ [ -f "${CONTAINER_MODELS_SEED}" ] && cp "${CONTAINER_MODELS_SEED}" "${agent}/${MODELS_FILE}" || true; } && ` +
		`${mergeSettings} && ` +
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
 *     (`/projects/<p>`, `/work/<p>`, or a root `/projects`/`/work`; legacy kept
 *     containers may still carry /root from the pre-0.12 bare-shell-at-home)
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
	const {machine, mode, projectsRoot, project, mountParent} = intent;
	const mounted = nonEmpty(mountParent) !== undefined;
	const rootKind: RootKind = mounted ? 'mount' : 'projects';
	// The same cwd resolution resolveRunPlan uses, so the key names the exact
	// container a matching launch would run in (its conversation key).
	const cwd = launchCwd(mode, rootKind, project);
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

// --- `forward` / `ports`: reach an in-jail server from the host --------------
//
// netcage owns two host-access verbs (>= 0.9.0): `netcage forward <container>
// [<hostPort>:]<jailPort>` stands up ONE host->jail inbound forward, and `netcage
// ports <container> --json` lists the jail's TCP LISTEN sockets image-independently
// (it reads the sidecar's /proc/net/tcp*, so a minimal image with no ss/netstat/nc
// still works). anon-pi wraps them so the user never handles the raw netcage
// container name: it resolves the RUNNING anon-pi container(s) by the identity key
// it now stamps on EVERY launch (withKeyLabel, not just --keep), disambiguates with
// a picker annotated by the open listeners, and shells out to `netcage forward`.
// The forced-egress invariant is untouched: `forward` adds no OUTPUT rule (ADR-0014)
// and `ports` only reads /proc; anon-pi composes neither egress flag here.

/**
 * PURE: the decoded fields of a stamped keptContainerKey (the reverse of
 * keptContainerKey's `k=v\n` record). Used by `forward`/`ports` to filter the
 * running managed containers by machine + project WITHOUT reconstructing the
 * exact key (which would couple to launchCwd). Unknown/missing fields are ''.
 */
export interface KeptKeyFields {
	machine: string;
	projectsRoot: string;
	mountParent: string;
	cwd: string;
}

/** PURE: parse a stamped keptContainerKey back into its fields (best-effort). */
export function parseKeptKey(key: string): KeptKeyFields {
	const out: KeptKeyFields = {
		machine: '',
		projectsRoot: '',
		mountParent: '',
		cwd: '',
	};
	for (const line of key.split('\n')) {
		const eq = line.indexOf('=');
		if (eq < 0) continue;
		const k = line.slice(0, eq);
		const v = line.slice(eq + 1);
		if (k === 'machine') out.machine = v;
		else if (k === 'projectsRoot') out.projectsRoot = v;
		else if (k === 'mountParent') out.mountParent = v;
		else if (k === 'cwd') out.cwd = v;
	}
	return out;
}

/**
 * PURE: the leaf name of a stamped key's cwd, i.e. the project a container hosts
 * (`/projects/recon` -> `recon`, `/projects` -> '.', `/work/x` -> `x`). Used to
 * filter the picker by `<project>` and to label each row. A root cwd
 * (`/projects`, `/work`) maps to the `.` root token; a legacy /root cwd (a
 * pre-0.12 bare shell that sat at the machine home) maps to '' (no project).
 */
export function keyProject(fields: KeptKeyFields): string {
	const cwd = fields.cwd;
	if (cwd === CONTAINER_PROJECTS_ROOT || cwd === CONTAINER_MOUNT_ROOT) {
		return ROOT_TOKEN;
	}
	if (cwd === CONTAINER_HOME_ROOT) return ''; // a bare shell, no project
	const slash = cwd.lastIndexOf('/');
	return slash < 0 ? cwd : cwd.slice(slash + 1);
}

/**
 * PURE: pick the RUNNING anon-pi containers a `forward`/`ports` should offer.
 * Filters the supplied running managed containers (each with its decoded key
 * fields) to those on `machine`, optionally narrowed to `project` (its leaf cwd
 * name). With no project, every anon-pi container on the machine qualifies. The
 * caller resolves 0 (error) / 1 (auto) / many (picker).
 */
export function resolveManagedMatches(args: {
	containers: readonly ManagedContainer[];
	machine: string;
	project?: string;
}): ManagedContainer[] {
	const {containers, machine, project} = args;
	return containers.filter((c) => {
		const f = parseKeptKey(c.key);
		if (f.machine !== machine) return false;
		if (project !== undefined && keyProject(f) !== project) return false;
		return true;
	});
}

/**
 * A RUNNING netcage-managed container the CLI surfaces to the pure forward/ports
 * resolution: its anon-pi identity `key` (stamped label, decoded), the `ref` to
 * pass to `netcage forward`/`ports` (id or name), and a human `name` for the
 * picker. Mirrors KeptContainer with the display name added.
 */
export interface ManagedContainer {
	key: string;
	ref: string;
	name: string;
}

/**
 * A parsed, validated port argument for `forward`: the in-jail port to reach and
 * the host port to bind it on (equal to the jail port unless a `<hostPort>:`
 * prefix remapped it). `raw` is the exact token to hand to netcage verbatim
 * (`3001` or `8080:3001`), so anon-pi never re-serialises netcage's grammar.
 */
export interface ForwardPort {
	hostPort: number;
	jailPort: number;
	raw: string;
}

/**
 * PURE: parse a `forward` port token `[<hostPort>:]<jailPort>` (docker/kubectl
 * host-first order). One port `3001` maps host 3001 -> jail 3001; `8080:3001`
 * maps host 8080 -> jail 3001. Both sides must be integers in 1..65535. Throws
 * AnonPiError on a bad shape / out-of-range / extra colon, with copy-pasteable
 * guidance. `raw` is normalised to `<host>:<jail>` only when they differ, else
 * the bare jail port, matching netcage's own accepted forms.
 */
export function parsePortArg(token: string): ForwardPort {
	const bad = (why: string): never => {
		throw new AnonPiError(
			`anon-pi: invalid --port ${JSON.stringify(token)}: ${why}. ` +
				'Use <jailPort> (e.g. 3001) or <hostPort>:<jailPort> (e.g. 8080:3001), ' +
				'each 1..65535.',
		);
	};
	const parts = token.split(':');
	if (parts.length > 2) bad('too many colons');
	const toPort = (s: string): number => {
		if (!/^[0-9]+$/.test(s)) bad(`${JSON.stringify(s)} is not a port number`);
		const n = Number(s);
		if (n < 1 || n > 65535) bad(`${s} is out of range (1..65535)`);
		return n;
	};
	if (parts.length === 1) {
		const p = toPort(parts[0]);
		return {hostPort: p, jailPort: p, raw: String(p)};
	}
	const hostPort = toPort(parts[0]);
	const jailPort = toPort(parts[1]);
	const raw =
		hostPort === jailPort ? String(jailPort) : `${hostPort}:${jailPort}`;
	return {hostPort, jailPort, raw};
}

/** A parsed `anon-pi forward` command (pure; the CLI does the netcage I/O). */
export interface ForwardCommand {
	project?: string;
	machine: string;
	machineExplicit: boolean;
	/** The parsed port, or undefined to prompt from the container's listeners. */
	port?: ForwardPort;
	/** `--bind <addr>` passed through to netcage verbatim (undefined => netcage default). */
	bind?: string;
}

/**
 * PURE: parse `anon-pi forward [<project>] [--port <[hostPort:]jailPort>]
 * [--bind <addr>] [-m <machine>]`. The bare positional is ALWAYS the project (so
 * a numeric name like `3001` is a project, never a port); the port is the
 * `--port`/`-p` flag, removing the number-vs-project ambiguity. `--bind` is
 * passed through to netcage (which validates 127.0.0.1 / 0.0.0.0). Throws
 * AnonPiError on an unknown flag, a missing flag argument, a second positional,
 * or a bad port.
 */
export function parseForwardArgs(args: readonly string[]): ForwardCommand {
	const fail = (msg: string): never => {
		throw new AnonPiError(`anon-pi: ${msg}\nRun \`anon-pi forward --help\`.`);
	};
	let project: string | undefined;
	let machine = DEFAULT_MACHINE;
	let machineExplicit = false;
	let port: ForwardPort | undefined;
	let bind: string | undefined;
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === '-m' || a === '--machine') {
			const v = args[++i];
			if (v === undefined) fail(`${a} needs a machine name`);
			machine = validateName(v as string, 'machine');
			machineExplicit = true;
		} else if (a === '-p' || a === '--port') {
			const v = args[++i];
			if (v === undefined) fail(`${a} needs a port ([hostPort:]jailPort)`);
			port = parsePortArg(v as string);
		} else if (a === '--bind') {
			const v = args[++i];
			if (v === undefined)
				fail('--bind needs an address (127.0.0.1 or 0.0.0.0)');
			bind = v as string;
		} else if (a.startsWith('-')) {
			fail(`unknown option: ${a}`);
		} else if (project === undefined) {
			project = validateName(a, 'project');
		} else {
			fail(`unexpected argument: ${a} (forward takes at most one project)`);
		}
	}
	return {project, machine, machineExplicit, port, bind};
}

/** A parsed `anon-pi ports` command (pure). */
export interface PortsCommand {
	project?: string;
	machine: string;
	machineExplicit: boolean;
}

/**
 * PURE: parse `anon-pi ports [<project>] [-m <machine>]`. Like forward but with
 * no port/bind: it lists a container's open in-jail listeners. The bare
 * positional is the project filter.
 */
export function parsePortsArgs(args: readonly string[]): PortsCommand {
	const fail = (msg: string): never => {
		throw new AnonPiError(`anon-pi: ${msg}\nRun \`anon-pi ports --help\`.`);
	};
	let project: string | undefined;
	let machine = DEFAULT_MACHINE;
	let machineExplicit = false;
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === '-m' || a === '--machine') {
			const v = args[++i];
			if (v === undefined) fail(`${a} needs a machine name`);
			machine = validateName(v as string, 'machine');
			machineExplicit = true;
		} else if (a.startsWith('-')) {
			fail(`unknown option: ${a}`);
		} else if (project === undefined) {
			project = validateName(a, 'project');
		} else {
			fail(`unexpected argument: ${a} (ports takes at most one project)`);
		}
	}
	return {project, machine, machineExplicit};
}

/**
 * A jail TCP LISTEN socket, as netcage's `ports --json` reports it: the bind
 * `address`, the `port`, and `loopbackOnly` (bound 127.0.0.0/8 or ::1). The
 * contract is netcage's (ADR-0015); anon-pi only consumes it.
 */
export interface NetcageListener {
	address: string;
	port: number;
	loopbackOnly: boolean;
}

/**
 * PURE: parse `netcage ports --json` output into listeners (best-effort). Keeps
 * only well-formed `{address:string, port:int, loopbackOnly:bool}` entries;
 * anything else (a netcage version drift, a non-array) yields []. The caller
 * treats [] as "no hint", never an error.
 */
export function parseNetcagePortsJson(stdout: string): NetcageListener[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	const out: NetcageListener[] = [];
	for (const e of parsed) {
		if (!e || typeof e !== 'object') continue;
		const r = e as Record<string, unknown>;
		if (
			typeof r.address === 'string' &&
			typeof r.port === 'number' &&
			typeof r.loopbackOnly === 'boolean'
		) {
			out.push({
				address: r.address,
				port: r.port,
				loopbackOnly: r.loopbackOnly,
			});
		}
	}
	return out;
}

/**
 * The netcage label anon-pi stamps its identity key onto (withKeyLabel). Kept
 * here so the pure ps-JSON parser and the CLI's stamp/read agree on one name.
 */
export const ANON_PI_KEY_LABEL = 'anon-pi.key';

/**
 * A raw `netcage ps --format json` entry, as anon-pi consumes it: the fields the
 * container-resolution needs. netcage forwards podman's JSON verbatim (>= 0.10.0),
 * so `Id`/`Names`/`Labels`/`State` are podman's own shape.
 */
export interface NetcagePsEntry {
	Id?: string;
	Names?: string[];
	Labels?: Record<string, string>;
	State?: string;
}

/**
 * PURE: parse `netcage ps --format json` into the anon-pi-owned containers:
 * exactly the entries that carry an `anon-pi.key` label (so a netcage sidecar,
 * which has no such label, is dropped), each as {key: <RAW base64 label value>,
 * ref: <Id>, name: <first Names entry or Id>}. When `runningOnly`, entries whose
 * State is not "running" are dropped (forward/ports can only reach a live jail).
 * The base64 DECODE of `key` is the CLI's job (Buffer), so this stays pure; the
 * caller decodes before matching against a keptContainerKey. [] on bad JSON.
 */
export function parseNetcagePsJson(
	stdout: string,
	opts: {runningOnly?: boolean} = {},
): {key: string; ref: string; name: string}[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	const out: {key: string; ref: string; name: string}[] = [];
	for (const e of parsed) {
		if (!e || typeof e !== 'object') continue;
		const entry = e as NetcagePsEntry;
		const labels = entry.Labels;
		if (!labels || typeof labels !== 'object') continue;
		const rawKey = labels[ANON_PI_KEY_LABEL];
		if (typeof rawKey !== 'string' || rawKey === '') continue; // not anon-pi's (e.g. a sidecar)
		if (opts.runningOnly && entry.State !== 'running') continue;
		const ref = typeof entry.Id === 'string' ? entry.Id : '';
		if (ref === '') continue;
		const name =
			Array.isArray(entry.Names) && typeof entry.Names[0] === 'string'
				? entry.Names[0]
				: ref;
		out.push({key: rawKey, ref, name});
	}
	return out;
}

/** netcage's in-jail DNS forwarder always listens here; anon-pi hides it from the port hint. */
export const NETCAGE_DNS_PORT = 53;

/**
 * PURE: the in-jail ports worth offering as forward targets: the listeners with
 * netcage's own `127.0.0.1:53` DNS forwarder dropped (it is never something a
 * user forwards), de-duplicated by port, sorted ascending. A server bound on
 * both IPv4 and IPv6 (two listeners, same port) collapses to one entry.
 */
export function forwardablePorts(
	listeners: readonly NetcageListener[],
): number[] {
	const ports = new Set<number>();
	for (const l of listeners) {
		if (l.port === NETCAGE_DNS_PORT && l.loopbackOnly) continue;
		ports.add(l.port);
	}
	return [...ports].sort((a, b) => a - b);
}

/**
 * PURE: a compact one-line hint of a container's forwardable in-jail ports for
 * the picker / the pre-forward confirmation, e.g. `open: 3001, 5173` or
 * `open: (none detected)`. Never includes the DNS forwarder (forwardablePorts).
 */
export function formatPortsHint(listeners: readonly NetcageListener[]): string {
	const ports = forwardablePorts(listeners);
	return ports.length === 0
		? 'open: (none detected)'
		: `open: ${ports.join(', ')}`;
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
 * What ONE selectable menu row launches, so the CLI can dispatch a chosen entry
 * without re-deriving anything:
 *   - `project` -> pi in `/projects/<project>` (the `anon-pi <project>` launch);
 *   - `here`    -> a scratch pi at the root itself (the `.` root token launch);
 *   - `new`     -> prompt+validate a new project name, then launch it as pi;
 *   - `shell`   -> the `--shell` jailed-bash launch.
 */
export type MenuEntryKind = 'project' | 'here' | 'new' | 'shell';

/** One rendered, selectable menu row: what it launches + its human label. */
export interface MenuEntry {
	/** Which launch this row dispatches to (project | here | new | shell). */
	kind: MenuEntryKind;
	/**
	 * The project token this row launches: a validated project name (`project`),
	 * the root token `.` (`here`), or undefined (`new` prompts for it, `shell`
	 * takes none). This is exactly the `project` field a launch dispatch feeds
	 * back into the grammar, so no re-parsing is needed.
	 */
	project?: string;
	/**
	 * The rendered row text the selector prints: the project name plus its
	 * used-on / new-here annotation (project rows), or the fixed affordance label
	 * (here / new / shell). The annotation is the ONLY place the usage record
	 * surfaces to the user, so the wording lives here (pure) not in the TUI.
	 */
	label: string;
}

/** The fixed labels for the non-project affordances (one source, so the TUI + its test agree). */
export const MENU_HERE_LABEL = '. (here: a scratch pi at the root)';
export const MENU_NEW_LABEL = '+ new project\u2026';
export const MENU_SHELL_LABEL = 'shell (a jailed bash on this machine)';

/**
 * PURE: render ONE project row's annotation from its usage record. Files are
 * global but conversations are per-machine, so the row tells the user where a
 * conversation for this project already lives (`used on: <machines>`) and
 * whether the CURRENT machine has none yet (`new here`). An unused project on a
 * fresh machine is just `new here` (no machine list). This is the whole
 * user-visible surface of the derived usage record, kept pure + testable.
 */
export function formatProjectAnnotation(usage: ProjectUsage): string {
	const parts: string[] = [];
	if (usage.machines.length > 0) {
		parts.push(`used on: ${usage.machines.join(', ')}`);
	}
	if (usage.currentMachineIsNew) parts.push('new here');
	return parts.length > 0 ? `  (${parts.join('; ')})` : '';
}

/**
 * PURE: assemble the ordered, labelled, selectable menu rows from the choice-
 * list + the per-project usage record. The order is: the projects (in the
 * choice-list's stable sorted order), then the `.` "here" scratch entry, then
 * `+ new project\u2026` (when `canNew`), then `shell` (when `canShell`). Each
 * project row's label carries its used-on / new-here annotation
 * (formatProjectAnnotation). This holds ALL the menu's logic (order + wording)
 * so the raw-mode selector only renders these rows and dispatches the picked
 * one by its `kind`/`project`.
 *
 * The `usage` list is expected to be keyed to `choiceList.projects` (same order,
 * as deriveProjectUsage produces from the choice-list's projects); a project
 * with no matching usage entry gets a bare, unannotated row rather than erroring.
 */
export function buildMenuEntries(args: {
	choiceList: MenuChoiceList;
	usage: readonly ProjectUsage[];
}): MenuEntry[] {
	const {choiceList, usage} = args;
	const byProject = new Map(usage.map((u) => [u.project, u]));
	const entries: MenuEntry[] = choiceList.projects.map((project) => {
		const u = byProject.get(project);
		const annotation = u ? formatProjectAnnotation(u) : '';
		return {kind: 'project', project, label: `${project}${annotation}`};
	});
	entries.push({
		kind: 'here',
		project: choiceList.here,
		label: MENU_HERE_LABEL,
	});
	if (choiceList.canNew) entries.push({kind: 'new', label: MENU_NEW_LABEL});
	if (choiceList.canShell)
		entries.push({kind: 'shell', label: MENU_SHELL_LABEL});
	return entries;
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
 * apiKey values that are NOT real secrets (safe to carry into the anonymized
 * seed verbatim). Anything else is treated as a REAL secret: `init` refuses to
 * seed it (which would put a host credential into the anon home) unless the
 * operator passes `--force-allow-local-llm-api-key`.
 */
export const BENIGN_API_KEYS: ReadonlySet<string> = new Set([
	'',
	'none',
	'ollama',
	'no-key',
	'nokey',
	'local',
	'dummy',
	'sk-no-key-required',
]);

/** PURE: whether an apiKey looks like a REAL secret (i.e. not in the benign set). */
export function apiKeyLooksReal(apiKey: string | undefined): boolean {
	if (apiKey === undefined) return false;
	return !BENIGN_API_KEYS.has(apiKey.trim().toLowerCase());
}

/**
 * A pi model entry as anon-pi seeds it for the local provider. pi keys a model
 * by `id`; `name` is the display label and `cost` is all-zero (a LAN model is
 * free). A "server"-sourced entry is minimal (id/name/cost); a "configured"
 * entry (imported from the host models.json) preserves whatever extra fields it
 * carried (`contextWindow`, `maxTokens`, `reasoning`, `input`, ...) via the
 * index signature.
 */
export interface GeneratedModel {
	id: string;
	name: string;
	cost?: {input: number; output: number; cacheRead: number; cacheWrite: number};
	[k: string]: unknown;
}

/**
 * PURE: a candidate model for the `init` picker. `configured` means it came from
 * the host `~/.pi/agent/models.json` provider that matches the endpoint (a
 * well-tuned entry with its real config); otherwise it was only reported by the
 * endpoint's `/v1/models` (a bare id we synthesize a minimal entry for). The
 * picker marks configured ones so the user knows which are more likely correct.
 */
export interface ModelCandidate {
	id: string;
	configured: boolean;
	/** The full pi model entry to seed (rich for configured, minimal otherwise). */
	entry: GeneratedModel;
}

/**
 * PURE: turn a discovered model `id` into a minimal-but-valid pi model entry.
 * `name` defaults to the id; a LAN model is free, so every cost is 0.
 */
export function localModelEntry(id: string): GeneratedModel {
	return {
		id,
		name: id,
		cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
	};
}

/**
 * PURE: extract the model ids from a parsed OpenAI-compatible `/v1/models`
 * response (`{ data: [{ id }, ...] }`, as llama.cpp / vLLM / LM Studio serve).
 * Tolerates a bare array, a `models` key, missing/garbage input (returns []), so
 * `init` can feed whatever the endpoint returned straight in.
 */
export function parseModelsListing(raw: unknown): string[] {
	const rows: unknown[] = Array.isArray(raw)
		? raw
		: raw && typeof raw === 'object'
			? (((raw as Record<string, unknown>).data as unknown[]) ??
				((raw as Record<string, unknown>).models as unknown[]) ??
				[])
			: [];
	if (!Array.isArray(rows)) return [];
	const ids: string[] = [];
	for (const r of rows) {
		if (typeof r === 'string') {
			if (r.trim() !== '') ids.push(r.trim());
		} else if (r && typeof r === 'object') {
			const id = (r as Record<string, unknown>).id;
			if (typeof id === 'string' && id.trim() !== '') ids.push(id.trim());
		}
	}
	return ids;
}

/** The result of scanning a host models.json for the endpoint's provider. */
export interface HostProviderMatch {
	/** The matching provider's models as full pi entries (verbatim host config). */
	models: GeneratedModel[];
	/** The matching provider's apiKey (verbatim), for the benign/real check. */
	apiKey?: string;
	/** True iff that apiKey looks like a REAL secret (init refuses without --force). */
	apiKeyLooksReal: boolean;
}

/**
 * PURE: find, in a parsed host `~/.pi/agent/models.json`, the provider whose
 * `baseUrl` points at `llmEndpoint` (matched via hostPortKey), and return ONLY
 * that provider's models + apiKey. This is the anonymity-critical scoping: the
 * ONLY provider considered is the one served by the `--allow-direct` endpoint,
 * so no other provider (etherplay/google/a paid API) — and no other provider's
 * key — can ever enter the seed. Returns undefined when no provider matches.
 *
 * The `--allow-direct` target and this match both go through hostPortKey, so a
 * URL / ip:port / bare-ip host config all match the same endpoint.
 */
export function pickLocalProviderModels(
	hostModels: PiModelsFile,
	llmEndpoint: string,
): HostProviderMatch | undefined {
	const providers = hostModels.providers ?? {};
	const want = hostPortKey(llmEndpoint);
	for (const p of Object.values(providers)) {
		if (!p || typeof p !== 'object' || !p.baseUrl) continue;
		if (hostPortKey(p.baseUrl) !== want) continue;
		const models: GeneratedModel[] = [];
		for (const m of p.models ?? []) {
			if (m && typeof m === 'object') {
				const id = (m as Record<string, unknown>).id;
				if (typeof id === 'string' && id.trim() !== '') {
					models.push({...(m as GeneratedModel), id: id.trim()});
				}
			} else if (typeof m === 'string' && m.trim() !== '') {
				models.push(localModelEntry(m.trim()));
			}
		}
		return {
			models,
			apiKey: p.apiKey,
			apiKeyLooksReal: apiKeyLooksReal(p.apiKey),
		};
	}
	return undefined;
}

/**
 * PURE: merge the host-config models (rich, `configured: true`) with the
 * endpoint's live `/v1/models` ids (`configured: false` for any the host did not
 * already carry), into ONE deduped, sorted candidate list. Host config wins on
 * an id present in both (it has the real config). Every candidate here is served
 * by the endpoint, so every one is `--allow-direct`-reachable; the merge just
 * unions "what you already configured" with "what the server also offers".
 */
export function mergeModelSources(
	hostModels: readonly GeneratedModel[],
	serverIds: readonly string[],
): ModelCandidate[] {
	const byId = new Map<string, ModelCandidate>();
	for (const m of hostModels) {
		const id = m.id.trim();
		if (id === '') continue;
		byId.set(id, {id, configured: true, entry: {...m, id}});
	}
	for (const raw of serverIds) {
		const id = raw.trim();
		if (id === '' || byId.has(id)) continue;
		byId.set(id, {id, configured: false, entry: localModelEntry(id)});
	}
	return Array.from(byId.values()).sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * PURE: synthesize a pi `models.json` for the local provider from an endpoint
 * and the CHOSEN model entries. It normalises the endpoint with hostPortKey and
 * returns a models.json carrying exactly ONE provider (named LOCAL_PROVIDER_NAME
 * — a neutral name, no host fingerprint) pointed at that endpoint.
 *
 * `apiKey` defaults to the benign LOCAL_PROVIDER_API_KEY. A caller may pass the
 * host provider's real key ONLY under an explicit force flag; the benign/real
 * decision (and the refusal) lives in `init`, not here — this pure function just
 * writes what it is given.
 *
 * Accepts either full model entries (from the host config) or bare id strings
 * (which it turns into minimal entries). Empty models => a provider pointed at
 * the endpoint with no pickable model (the degraded fallback).
 */
export function generateModelsJson(
	llmEndpoint: string,
	models: readonly (GeneratedModel | string)[] = [],
	apiKey: string = LOCAL_PROVIDER_API_KEY,
): PiModelsFile {
	const hostPort = hostPortKey(llmEndpoint);
	const entries: GeneratedModel[] = [];
	const seen = new Set<string>();
	for (const m of models) {
		const entry = typeof m === 'string' ? localModelEntry(m.trim()) : m;
		const id = entry.id.trim();
		if (id === '' || seen.has(id)) continue;
		seen.add(id);
		entries.push({...entry, id});
	}
	entries.sort((a, b) => a.id.localeCompare(b.id));
	const provider: PiProvider = {
		api: LOCAL_PROVIDER_API,
		apiKey,
		baseUrl: `http://${hostPort}/v1`,
		models: entries,
	};
	return {providers: {[LOCAL_PROVIDER_NAME]: provider}};
}

/** The pi settings.json keys anon-pi sets for the local-model default selection. */
export interface ModelSelection {
	defaultProvider: string;
	defaultModel: string;
	enabledModels: string[];
}

/**
 * PURE: the model-selection settings.json fragment for the seeded local
 * provider: `defaultProvider` = LOCAL_PROVIDER_NAME, `defaultModel` = the chosen
 * default id, `enabledModels` = `local/<id>` for each imported model (pi's
 * `<provider>/<id>` convention). The caller MERGES this into any existing
 * settings so image-staged settings (packages/extensions) are preserved.
 */
export function generateModelSelection(
	modelIds: readonly string[],
	defaultId: string,
): ModelSelection {
	const ids = Array.from(
		new Set(modelIds.map((m) => m.trim()).filter((m) => m !== '')),
	).sort((a, b) => a.localeCompare(b));
	return {
		defaultProvider: LOCAL_PROVIDER_NAME,
		defaultModel: defaultId.trim(),
		enabledModels: ids.map((id) => `${LOCAL_PROVIDER_NAME}/${id}`),
	};
}

/**
 * PURE: shallow-merge the local-model selection into an existing (parsed)
 * settings.json object, returning the merged object. Only the three selection
 * keys are overwritten; every other key the user/image had (packages,
 * extensions, thinking level, ...) is preserved. `existing` undefined/garbage is
 * treated as `{}`.
 */
export function mergeModelSelection(
	existing: unknown,
	selection: ModelSelection,
): Record<string, unknown> {
	const base: Record<string, unknown> =
		existing && typeof existing === 'object'
			? {...(existing as Record<string, unknown>)}
			: {};
	base.defaultProvider = selection.defaultProvider;
	base.defaultModel = selection.defaultModel;
	base.enabledModels = selection.enabledModels;
	return base;
}

/**
 * The host `~/.pi/agent/models.json` path `init` reads the matching local
 * provider from. Uses the container-less host HOME (or PI_CODING_AGENT_DIR when
 * the user relocated pi's agent dir). This is READ-ONLY (init copies only the
 * ONE matching provider's models); it is never written.
 */
export function resolveHostModelsPath(env: AnonPiEnv): string {
	const agentDir =
		env.piAgentDir && env.piAgentDir.trim() !== ''
			? env.piAgentDir
			: join(env.home, '.pi', 'agent');
	return join(agentDir, MODELS_FILE);
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

// --- `anon-pi init` onboarding: the PURE proxy detect/verify DECISIONS --------
//
// `anon-pi init` onboards HONESTLY (this is an anonymity tool): its proxy step
// presents EVIDENCE only (open ports, a real SOCKS5 handshake, a real `netcage
// verify` exit IP) plus WEAK process hints. It MUST NEVER claim/label the exit
// provider: a SOCKS proxy does not announce Mullvad/Proton/NordVPN/etc, so a
// provider label would be a DANGEROUS LIE. This module owns the pure decisions
// (handshake interpretation, the findings-without-labels formatter, the weak
// hint wording, the verify exit-IP parse); the socket probes, the `netcage
// verify` / `podman build` spawns, and the prompts are cli.ts's thin I/O.

/**
 * The default SOCKS ports `init` probes, each with a WEAK, structural hint (the
 * conventional tool that DEFAULTS to that port). The hint names a local tool a
 * port is CONVENTIONALLY used by, NOT the exit provider: `9050`/`9150` are Tor's
 * own listeners (Tor IS the tool, so naming it is honest), `1080` is the generic
 * SOCKS default (wireproxy / `ssh -D` / other), which is why its hint stays
 * provider-agnostic ("wireproxy / ssh -D / generic"): behind a `1080` wireproxy
 * could be ANY WireGuard VPN, and we never guess which. See the ADR / Decisions.
 */
export const DEFAULT_SOCKS_PROBE_PORTS: readonly {
	port: number;
	hint: string;
}[] = [
	{port: 9050, hint: 'Tor default (system tor)'},
	{port: 9150, hint: 'Tor Browser default'},
	{port: 1080, hint: 'generic SOCKS (wireproxy / ssh -D)'},
];

/**
 * The SOCKS5 method-selection greeting `init` sends to CONFIRM a port really
 * speaks SOCKS5 (RFC 1928 §3): version 5, one method offered, `0x00`
 * (no-authentication). A real SOCKS5 server replies with two bytes
 * `[0x05, <method>]`; anything else is not SOCKS5. Exposed as a constant so the
 * probe I/O and the handshake test send byte-identical bytes.
 */
export const SOCKS5_METHOD_SELECTOR: readonly number[] = [0x05, 0x01, 0x00];

/** How a SOCKS5 handshake probe against a port came out (the pure verdict). */
export type SocksHandshake =
	| {
			/** The server replied with a well-formed SOCKS5 method-selection reply. */
			socks5: true;
			/** The selected method byte the server chose (informational). */
			method: number;
	  }
	| {
			/** The reply was absent, too short, or not a SOCKS5 version-5 reply. */
			socks5: false;
			/** A terse, provider-agnostic reason (for the findings line). */
			reason: string;
	  };

/**
 * PURE: interpret a SOCKS5 method-selection REPLY (the bytes read back after
 * sending SOCKS5_METHOD_SELECTOR). A valid reply is EXACTLY the two bytes
 * `[0x05, <method>]` where `<method> != 0xff` (0xff = "no acceptable methods",
 * i.e. the server IS SOCKS5 but rejected no-auth; that is still a SOCKS5 server,
 * but for a bare no-auth probe we treat it as a soft failure so the finding does
 * not imply the port is usable no-auth). Any non-5 first byte, a short reply, or
 * an empty reply is NOT SOCKS5.
 *
 * Reply in -> verdict out; the socket read is cli.ts's job. The reason strings
 * are deliberately structural ("no reply", "not SOCKS5") and NEVER name a
 * provider.
 */
export function interpretSocks5Handshake(
	reply: readonly number[] | Uint8Array | Buffer,
): SocksHandshake {
	const bytes = Array.from(reply as ArrayLike<number>);
	if (bytes.length === 0) return {socks5: false, reason: 'no reply'};
	if (bytes.length < 2) return {socks5: false, reason: 'short reply'};
	if (bytes[0] !== 0x05) return {socks5: false, reason: 'not SOCKS5'};
	const method = bytes[1];
	if (method === 0xff) {
		return {socks5: false, reason: 'SOCKS5 but no acceptable auth method'};
	}
	return {socks5: true, method};
}

/**
 * A weak process hint: a LOCAL tool whose presence SUGGESTS what a port is
 * (e.g. a `tor` process -> likely Tor). It is a hint about the LOCAL software
 * only, never a claim about the EXIT provider. cli.ts supplies the observed
 * process name (e.g. from `ps`/`/proc`); the pure mapping stays testable.
 */
export interface ProcessHint {
	/** The observed local process name (as cli.ts read it). */
	process: string;
	/** The weak, hedged hint text ("a `tor` process is running -> likely Tor"). */
	hint: string;
}

/**
 * PURE: map an observed local process name to a WEAK, hedged hint, or undefined
 * when we have nothing honest to say. The ONLY confident mapping is `tor` ->
 * "likely Tor", because Tor is a LOCAL tool that runs its OWN SOCKS listener (so
 * seeing `tor` is real evidence the port is Tor). We do NOT map anything to an
 * EXIT provider (Mullvad/Proton/...): a `wireproxy` process only tells us the
 * SOCKS front-end, never which VPN sits behind it, so its hint stays
 * provider-agnostic. Every returned hint is HEDGED ("likely", "-> a SOCKS
 * front-end") and never states the exit provider.
 */
export function processHint(processName: string): ProcessHint | undefined {
	const name = processName.trim().toLowerCase();
	if (name === '') return undefined;
	if (name === 'tor') {
		return {
			process: processName,
			hint: 'a `tor` process is running -> likely Tor',
		};
	}
	if (name === 'wireproxy') {
		return {
			process: processName,
			// A SOCKS front-end for SOME WireGuard VPN; we NEVER guess which one.
			hint:
				'a `wireproxy` process is running -> a SOCKS front-end for a ' +
				'WireGuard VPN (which one is not observable here)',
		};
	}
	return undefined;
}

/**
 * One probed SOCKS candidate, as `init` gathers it for the findings display. All
 * fields are EVIDENCE the probe actually observed; there is DELIBERATELY no
 * "provider" field, so the type itself cannot carry a provider label.
 */
export interface ProxyFinding {
	/** The host that was probed (usually 127.0.0.1). */
	host: string;
	/** The port that was probed. */
	port: number;
	/** Whether the TCP port was open (a connection succeeded). */
	open: boolean;
	/** The SOCKS5 handshake verdict (only meaningful when `open`). */
	handshake?: SocksHandshake;
	/** The port's structural hint (DEFAULT_SOCKS_PROBE_PORTS), if any. */
	portHint?: string;
	/** Any weak LOCAL process hint (processHint), if one was observed. */
	processHint?: string;
}

/** What `netcage detect-proxy --json` reports (the fields anon-pi consumes). */
export interface NetcageDetectProxy {
	schemaVersion?: number;
	candidates?: Array<{
		port?: number;
		open?: boolean;
		socks5?: boolean;
		processHint?: string;
	}>;
	exitIP?: string;
}

/**
 * PURE: map a parsed `netcage detect-proxy --json` result into anon-pi's
 * ProxyFinding[] (so init can REUSE netcage's SOCKS scanner instead of its own
 * probe, and both render through the same formatProxyFindings). The host is
 * 127.0.0.1 (detect-proxy probes loopback); the socks5 boolean becomes a
 * SocksHandshake verdict; the structural port hint is attached from
 * DEFAULT_SOCKS_PROBE_PORTS by port. Tolerates missing/garbage (returns []).
 * The per-candidate processHint is NOT copied onto each finding (it is host-wide;
 * the CLI passes it once as formatProxyFindings' note).
 */
export function findingsFromNetcageDetect(
	raw: NetcageDetectProxy | undefined,
): ProxyFinding[] {
	const rows = raw?.candidates;
	if (!Array.isArray(rows)) return [];
	const hintByPort = new Map(
		DEFAULT_SOCKS_PROBE_PORTS.map((p) => [p.port, p.hint]),
	);
	const out: ProxyFinding[] = [];
	for (const c of rows) {
		if (!c || typeof c.port !== 'number') continue;
		const open = c.open === true;
		const handshake: SocksHandshake | undefined = !open
			? undefined
			: c.socks5 === true
				? {socks5: true, method: 0}
				: {socks5: false, reason: 'not SOCKS5'};
		out.push({
			host: '127.0.0.1',
			port: c.port,
			open,
			handshake,
			portHint: hintByPort.get(c.port),
		});
	}
	return out;
}

/**
 * PURE: the host-wide process note from a `netcage detect-proxy --json` result:
 * the FIRST candidate that carries a `processHint` (they are all the same
 * host-wide hint). Returns undefined when none. Rendered ONCE by the CLI (not
 * per port), same as the local-probe path.
 */
export function processNoteFromNetcageDetect(
	raw: NetcageDetectProxy | undefined,
): string | undefined {
	for (const c of raw?.candidates ?? []) {
		if (c && typeof c.processHint === 'string' && c.processHint.trim() !== '') {
			return c.processHint.trim();
		}
	}
	return undefined;
}

/**
 * The set of substrings a findings line must NEVER contain: known exit-provider
 * / VPN brand names. This is the machine-checkable half of the never-label rule
 * (a test asserts formatProxyFindings' output contains NONE of these for any
 * input). It is not exhaustive of every brand, but it pins the obvious ones so a
 * regression that starts labelling providers is caught. `tor` is NOT here: Tor
 * is the LOCAL tool we legitimately hint at, not an opaque exit provider.
 */
export const FORBIDDEN_PROVIDER_LABELS: readonly string[] = [
	'mullvad',
	'proton',
	'nordvpn',
	'nord vpn',
	'expressvpn',
	'express vpn',
	'surfshark',
	'ivpn',
	'pia',
	'private internet access',
	'cyberghost',
	'windscribe',
];

/**
 * PURE: format the probe findings into the human-readable block `init` shows
 * before asking the user to CHOOSE a proxy. It renders EVIDENCE ONLY: for each
 * candidate, the `host:port`, whether it is open, the SOCKS5 handshake verdict,
 * and the structural PORT hint. It NEVER emits an exit-provider label (a SOCKS
 * proxy does not announce its provider; a false label is a dangerous lie). The
 * `## Decisions` note + a test assert the output never contains a
 * FORBIDDEN_PROVIDER_LABELS substring for any input.
 *
 * `processNote` is the HOST-WIDE weak process hint (a running `tor`/`wireproxy`
 * LOCAL process), shown ONCE as a general note rather than glued onto every port
 * line: the observation is host-wide, not per-port, so repeating it on each
 * candidate (including closed ports the process is unrelated to) reads as noise.
 * A per-finding `processHint`, if still set, is also honoured inline for
 * backward compatibility, but `init` now passes the host-wide note instead.
 *
 * Findings in -> display string out; the socket probes are cli.ts's job.
 */
export function formatProxyFindings(
	findings: readonly ProxyFinding[],
	processNote?: string,
): string {
	if (findings.length === 0) {
		return 'No SOCKS ports responded on the probed set. Enter your proxy as host:port.';
	}
	const lines: string[] = [];
	for (const f of findings) {
		const where = `${f.host}:${f.port}`;
		let status: string;
		if (!f.open) {
			status = 'closed (no TCP connection)';
		} else if (f.handshake && f.handshake.socks5) {
			status = 'open, SOCKS5 handshake OK';
		} else if (f.handshake && !f.handshake.socks5) {
			status = `open, but NOT SOCKS5 (${f.handshake.reason})`;
		} else {
			status = 'open';
		}
		const hints: string[] = [];
		if (f.portHint) hints.push(f.portHint);
		if (f.processHint) hints.push(f.processHint);
		const hintStr = hints.length > 0 ? ` [${hints.join('; ')}]` : '';
		lines.push(`${where}: ${status}${hintStr}`);
	}
	// The host-wide process observation, shown ONCE (not per port). It is a weak
	// LOCAL hint, never an exit-provider label.
	if (processNote && processNote.trim() !== '') {
		lines.push(`Note: ${processNote.trim()}`);
	}
	lines.push(
		'These are EVIDENCE only (open ports + a real SOCKS5 handshake). A SOCKS ' +
			'proxy does not announce its exit provider, so none is claimed here; the ' +
			'`netcage verify` step below shows the real exit IP as proof.',
	);
	return lines.join('\n');
}

/**
 * PURE: the `socks5h://<host:port>` URL `init` hands to `netcage verify` and
 * writes into config.json. Only socks5h:// is accepted downstream (plain
 * socks5:// resolves DNS locally and leaks), so `init` always emits socks5h.
 * A value that already carries a scheme is normalised to its host:port first
 * (via hostPortKey) so `socks5h://socks5h://...` can never be produced.
 */
export function socks5hUrl(hostPort: string): string {
	return `socks5h://${hostPortKey(hostPort)}`;
}

/**
 * PURE: extract the exit IP `netcage verify` reported from its combined output.
 * `netcage verify` prints the jail's forced-egress exit IP (an IPv4/IPv6 line)
 * as PROOF the egress leaves via the proxy (not the host IP). We scan the output
 * for the first plausible IP literal and return it; undefined if none is found
 * (the caller then shows the raw output and lets the user judge). This is a
 * best-effort PARSE of another tool's text, kept pure + tested so a format tweak
 * is caught by a unit test, not only in the field.
 */
export function parseVerifyExitIp(output: string): string | undefined {
	// IPv4 first (the common case: ipify returns an IPv4 for most exits).
	const v4 = output.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
	if (v4) {
		const ip = v4[0];
		if (ip.split('.').every((o) => Number(o) <= 255)) return ip;
	}
	// IPv6 (a loose match: at least two groups and a colon-run), best-effort.
	const v6 = output.match(/\b(?:[0-9a-fA-F]{0,4}:){2,}[0-9a-fA-F]{0,4}\b/);
	if (v6 && v6[0].includes('::')) return v6[0];
	if (v6 && v6[0].split(':').filter(Boolean).length >= 3) return v6[0];
	return undefined;
}

/**
 * The image-menu choices `init` offers for the default machine's image. `[1]`
 * and `[2]` build a SHIPPED Dockerfile via `podman build`; `[3]` takes an
 * existing image ref verbatim; `[4]` skips (the machine is created imageless and
 * pinned later). The pure list keeps the menu wording testable; cli.ts renders
 * it, runs `podman build`, and writes the machine.
 */
export type InitImageChoice = 'basic' | 'webveil' | 'existing' | 'skip';

/** One rendered image-menu entry: its choice tag + the human label. */
export interface InitImageMenuEntry {
	choice: InitImageChoice;
	label: string;
}

/**
 * PURE: the ordered image-menu entries `init` shows. `[1]` basic pi
 * (Dockerfile.pi), `[2]` pi + webveil/SearXNG (examples/Dockerfile.pi-webveil),
 * `[3]` an existing image ref, `[4]` skip. A single source so the prompt and its
 * test agree on the order + wording.
 */
export function initImageMenu(): InitImageMenuEntry[] {
	return [
		{choice: 'basic', label: 'basic pi (build the shipped Dockerfile.pi)'},
		{
			choice: 'webveil',
			label:
				'pi + webveil/SearXNG (build the shipped examples/Dockerfile.pi-webveil)',
		},
		{choice: 'existing', label: 'an existing image ref (I already have one)'},
		{
			choice: 'skip',
			label: 'skip (create the machine imageless; pin it later)',
		},
	];
}

/**
 * PURE: build the `config.json` body `init` writes, keeping only the non-empty
 * fields (a skipped image / llm is simply omitted, never written as ""). Emits
 * pretty-printed JSON (tab indent, trailing newline) matching
 * serializeMachineJson, so a browsed ~/.anon-pi/config.json reads cleanly. The
 * proxy is REQUIRED (init only reaches here after a verified proxy), so it is
 * always present; llm / defaultMachine / projects are included when set.
 */
export function serializeConfigJson(config: AnonPiConfig): string {
	const out: AnonPiConfig = {};
	const proxy = nonEmpty(config.proxy);
	if (proxy !== undefined) out.proxy = proxy;
	const llm = nonEmpty(config.llm);
	if (llm !== undefined) out.llm = llm;
	const defaultMachine = nonEmpty(config.defaultMachine);
	if (defaultMachine !== undefined) out.defaultMachine = defaultMachine;
	const projects = nonEmpty(config.projects);
	if (projects !== undefined) out.projects = projects;
	return JSON.stringify(out, null, '\t') + '\n';
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

/**
 * anon-pi's own version, read from the package.json shipped in the package root
 * (resolved via shippedFile). Returns undefined if it cannot be found/parsed, so
 * `--version` can fall back to a placeholder. Read-only.
 */
export function anonPiVersion(): string | undefined {
	const pkg = shippedFile('package.json');
	if (!pkg) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(pkg, 'utf8')) as {version?: unknown};
		return typeof parsed.version === 'string' ? parsed.version : undefined;
	} catch {
		return undefined;
	}
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
		piAgentDir: penv.PI_CODING_AGENT_DIR,
		dockerfilePath: shippedDockerfilePath(),
		webveilDockerfilePath: shippedWebveilDockerfilePath(),
	};
}

/** The --help text (kept here so it is covered by the same module). */
export const HELP = `anon-pi - run pi on anonymized, jailed machines (netcage: forced egress + one direct local model)

USAGE
  anon-pi                        MENU: pick a project (pi), a shell, or a new project
  anon-pi <project>              pi in the project (${CONTAINER_PROJECTS_ROOT}/<project>); exit pi -> host
  anon-pi <project> <pi-args…>   forward args to pi (e.g. -p for a headless one-shot)
  anon-pi --session <id>         resume a pi session by id, in its own project (also -r/--resume)
  anon-pi <project> --fork <id>  fork a session into <project> (\`.\`=root; --continue too; project required)
  anon-pi --list-models          list the models pi sees (also --models; no project needed)
  anon-pi pi <pi-args…>          run pi with ANY args and no project (the passthrough)
  anon-pi --version              print anon-pi's version (also -V)
  anon-pi --shell [<project>]    a jailed bash (at /projects, or cd'd into <project>) - the project-hopper
  anon-pi forward [<p>] [--port …]  open a host port onto a running container's in-jail server
  anon-pi ports [<project>]      list a running container's open in-jail TCP listeners
  anon-pi -m <machine> [<p>]     the same, on <machine> (its own image + home + conversations)
  anon-pi --mount <parent> [<p>] root at a HOST parent folder instead of the projects root
  anon-pi init                   onboard: verify your proxy, capture your local model, pick an image
  anon-pi machine …              manage machines (create / list / set-image / rm)
  anon-pi --delete-home [<m>]    delete a machine's home (config + convos); keep its image pin + files
  anon-pi --delete-project <p>   delete a project's files + its per-machine sessions; keep the homes

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
