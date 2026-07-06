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
//   - Every launch is THROWAWAY (the container is always `--rm`): it is removed
//     on exit. Durable state is EXPLICIT and image-based (snapshot a running
//     container into a named image, then a machine pinned to it); the machine
//     home persists regardless (it is a host mount). See docs/adr/0004.
//   - Open exactly ONE direct hole (--allow-direct <llm>) so pi can reach a
//     local model while ALL other egress stays forced through the socks5h proxy
//     (fail-closed; the proxy is REQUIRED and never guessed).
//   - Seed-if-fresh (marker-guarded, per MACHINE home): on a fresh home, promote
//     the image's /root defaults + pi staging + the generated models.json into
//     the home once, then stamp the marker and never clobber it again.
//
// This module holds every DECISION as a pure function (config load + precedence,
// machine/project resolvers, name validation, the RunPlan argv, the menu
// choice-list, project usage, models.json generation, init's proxy detect/verify
// decisions). cli.ts owns only the impure edges (fs, the interactive TUI, the
// netcage query, the spawn).

import {existsSync, readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname, join, resolve, sep} from 'node:path';
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
 * Reserved names that a machine/project/image may NOT take (case-sensitive).
 * `.` is the root token (see ROOT_TOKEN); `..` is parent-traversal (both are
 * also rejected by the structural checks below, but listed here so the
 * reserved-name concept is explicit). `pi` is the passthrough token. The
 * SUBCOMMAND NOUN words (`machine`, `image`, `container`, `init`, `forward`,
 * `ports`) are reserved too: each is dispatched BEFORE the launch grammar, so a
 * folder so named would be UNREACHABLE by bare name (a latent trap). Reserving
 * them makes
 * validateName refuse such a name up front with a clear error, closing the
 * trap. `--mount`'s `/work` is a CONTAINER path, not a name here, so it needs no
 * reservation. The reservation is GLOBAL (validateName is the one validator);
 * the menu tolerates a pre-existing folder now reserved by FILTERING it out via
 * the try/catch isProjectName, so a now-reserved folder is skipped, not a crash.
 */
export const RESERVED_NAMES: readonly string[] = [
	'.',
	'..',
	'pi',
	'machine',
	'image',
	'container',
	'init',
	'forward',
	'ports',
];
// NOTE: `pi` is reserved so the `anon-pi pi <args…>` passthrough token
// (PI_PASSTHROUGH_TOKEN) can never be shadowed by a project named `pi`; the
// subcommand nouns are reserved so a same-named folder is never an unreachable
// shadow of a dispatched verb.

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
 * here (it is argv-less). Shared by resolveRunPlan + launchIdentityKey so the run
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
	/**
	 * True iff this install is CONFIGURED-HARDENED: the whole workspace runs under
	 * the dedicated `anon` account and every login-user invocation self-re-execs
	 * as `anon` (docs/adr/0006). Set by `init`'s hardening step; read by the launch
	 * entry (shouldRedirectToAnon). Absent/false = a normal (non-hardened) install.
	 */
	hardened?: boolean;
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

/** Pick a boolean field from a parsed-JSON object, or undefined if absent/non-boolean. */
function boolField(o: unknown, key: string): boolean | undefined {
	if (!o || typeof o !== 'object') return undefined;
	const v = (o as Record<string, unknown>)[key];
	return typeof v === 'boolean' ? v : undefined;
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
	const hardened = boolField(raw, 'hardened');
	if (hardened !== undefined) out.hardened = hardened;
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
 * PURE: does a chosen projects root LEAK the login username on a hardened
 * install? The projects root is the HOST bind-mount SOURCE for /projects, so its
 * host path is part of the container's mount spec. On a hardened install anon-pi
 * runs under the dedicated `anon`/`anon-<name>` account precisely so nothing the
 * machine can observe carries the login user's identity; a projects root that
 * sits UNDER the login user's home (`/home/<login>/...`) re-introduces that leak
 * (the username in the mount-source path, plus login-user file OWNERSHIP mounted
 * into an anon-run jail, which also defeats the mode-700 discoverability
 * boundary). Returns true only when hardened AND the resolved root is at or under
 * `loginHome`. A non-hardened install never leaks (there is no persona account to
 * contrast with), so it always returns false. All inputs are injected; nothing
 * here spawns or touches the fs.
 */
export function projectsRootLeaksLogin(args: {
	/** The resolved (absolute) host projects root. */
	projectsRoot: string;
	/** The login user's $HOME (the account `init` was invoked from). */
	loginHome: string;
	/** Whether this install is (being) configured hardened. */
	hardened: boolean;
}): boolean {
	if (!args.hardened) return false;
	const root = resolve(args.projectsRoot);
	const home = resolve(args.loginHome);
	return root === home || root.startsWith(home + sep);
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

/**
 * PURE: resolve the IMAGE a launch runs against, highest-priority first:
 * a per-launch `-i`/`--image` override > the machine's pinned image
 * (machine.json) > `ANON_PI_IMAGE` (the env fallback) > undefined (the CLL then
 * errors). The `-i` override is STRICTLY EPHEMERAL: it selects the image for
 * THIS launch only and is NEVER written back to machine.json (that persistent
 * pin is `machine set-image` / `machine create --image`). No mismatch warning is
 * ever emitted (ADR-0003 section 3: `-i` is explicit + ephemeral, so a warning
 * carries no information the user lacks). Empty strings are treated as unset at
 * every tier (nonEmpty), so a blank env/pin falls through cleanly.
 */
export function resolveLaunchImage(args: {
	/** The per-launch `-i`/`--image` override (ParsedLaunch.image), if given. */
	override?: string;
	/** The machine's pinned image (machine.json.image), if set. */
	machineImage?: string;
	/** The `ANON_PI_IMAGE` env fallback, if set. */
	envImage?: string;
}): string | undefined {
	return (
		nonEmpty(args.override) ??
		nonEmpty(args.machineImage) ??
		nonEmpty(args.envImage)
	);
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
	/**
	 * The DURABLE-box marker (the explicit `container` noun; see the container ADR
	 * that supersedes ADR-0004's "lost capability" note). When set, the launch is a
	 * durable named box: resolveRunPlan OMITS `--rm` (the box survives exit),
	 * `--name`s the container by `durable.name` (so `container enter` can
	 * `netcage start <name>`), and stamps the `anon-pi.container` label carrying the
	 * name (so `container list`/`rm` read boxes back off the label). ORTHOGONAL to
	 * the identity fields: launchIdentityKey is unchanged by it, so the durable box
	 * is resolvable by `forward`/`ports` EXACTLY as a throwaway launch. Omitted =>
	 * the default THROWAWAY launch (`--rm`, no name, no container label).
	 */
	durable?: {name: string};
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
 * (a path, NOT a name-namespaced token). `image` is the ephemeral per-launch
 * `-i`/`--image` override (undefined when not given). Every launch is throwaway
 * (`--rm` always; the retired `--keep`/`--rm` flags now error). `piArgs` are the
 * trailing tokens forwarded to pi (pi mode only; undefined otherwise).
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
	/**
	 * The EPHEMERAL per-launch image override (`-i <ref>` / `--image <ref>`), or
	 * undefined. Highest priority in the image-resolution chain (see
	 * resolveLaunchImage): `-i` > machine.json.image > ANON_PI_IMAGE. It NEVER
	 * mutates machine.json (that persistent pin is `machine set-image` /
	 * `machine create --image`); `-i` picks the IMAGE for this launch while `-m`
	 * picks the HOME, and they compose. The ref is passed straight through to
	 * netcage's private image store: anon-pi does NOT pre-check it or auto-pull.
	 */
	image?: string;
	piArgs?: string[];
	/**
	 * True iff the launch requested the anon-pi WATCH stream (`-p --mode
	 * text-stream`). When set, `piArgs` already carry `--mode json` (so pi emits
	 * the event stream) and the CLI captures + renders that stream instead of
	 * inheriting pi's stdout. Only ever true for a HEADLESS pi run (extractWatchMode
	 * requires `-p`). Undefined/false => a normal launch.
	 */
	watch?: boolean;
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
 * For arbitrary pi flags with no project (e.g. `--model x`), anon-pi forwards
 * them to pi automatically (the flag + everything after it); the explicit
 * `anon-pi pi <args…>` passthrough is an equivalent, clearer spelling.
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
 * args and NO project. It is now mostly a CLARITY alias: any unrecognised-by-
 * anon-pi flag in the no-project position already forwards to pi (so `anon-pi
 * --model x` works without it), but the explicit `pi` token still reads clearly
 * and lets a BARE positional after it (`anon-pi pi -p ...`) be unambiguous. It is
 * a RESERVED project name (see RESERVED_NAMES) so a project can never shadow it.
 */
export const PI_PASSTHROUGH_TOKEN = 'pi';

/**
 * The retired launch flags. `--keep`/`--rm` are GONE (ADR-0004): every launch is
 * throwaway now, so there is no flag to toggle. `--keep`'s exploratory
 * "apt install, quit, re-enter" use case is served, better, by snapshotting a
 * running container into a named image and pinning a machine to it (explicit +
 * named, no inference). The label a launch is passed one of these RETIRED flags
 * gets a clear error pointing there.
 */
export const RETIRED_LAUNCH_FLAGS = ['--keep', '--rm'] as const;

/** PURE: the error message for a retired `--keep`/`--rm` flag, pointing at the image-based replacement. */
export function retiredKeepRmMessage(flag: string): string {
	return (
		`${flag} is gone: every launch is throwaway now (the container is always ` +
		`removed on exit). To persist system state you set up in a session (e.g. after ` +
		`\`apt install\`), snapshot the RUNNING container into a named image and use it:\n` +
		`  anon-pi image snapshot <name>        (freeze the running container -> anon-pi/<name>:latest)\n` +
		`  anon-pi machine create <m> --image anon-pi/<name>:latest   (a durable machine pinned to it)\n` +
		`Your pi config + conversations live in the machine home (a host mount) and persist regardless.`
	);
}

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

// --- `--mode text-stream`: the anon-pi WATCH surface over a headless pi run ---
//
// pi's default `-p` (`--mode text`) prints ONLY the final answer, so a one-shot
// run looks frozen while the agent works. pi CAN stream, but only as `--mode
// json` (a raw JSONL event stream, unpleasant to read). anon-pi bridges the two
// with the anon-pi-OWNED mode value `text-stream`: the user writes `-p --mode
// text-stream`; anon-pi STRIPS that token, forwards `-p --mode json` to pi
// inside the jail, then PARSES the JSONL stream on the host and renders a
// readable, dorfl-style per-turn view (assistant text + `\u25b6 <tool>` lines)
// to stderr, with pi's final answer still going to stdout so the run stays
// pipeable. anon-pi OWNS `--mode`: combining `text-stream` with a second
// `--mode` (or using it without `-p`) is refused in extractWatchMode.

/** The pi `--mode` flag anon-pi intercepts to own the mode value. */
export const MODE_FLAG = '--mode';

/**
 * The anon-pi-owned pseudo-mode. The user passes `--mode text-stream`; it never
 * reaches pi (anon-pi rewrites it to `--mode json` and renders the stream).
 */
export const WATCH_MODE_TOKEN = 'text-stream';

/** The real pi mode anon-pi forwards into the jail to GET the event stream. */
export const WATCH_PI_MODE = 'json';

/**
 * PURE: interpret `--mode text-stream` in the forwarded pi args. Returns the
 * args with any anon-pi-owned `--mode text-stream` REMOVED and a `watch` flag:
 *
 *   - no `--mode text-stream` present => `{watch:false, piArgs}` unchanged.
 *   - `--mode text-stream` present => `{watch:true, piArgs}` with THAT flag+value
 *     pair stripped (pi never sees it; the caller re-injects `--mode json`).
 *
 * REFUSALS (AnonPiError), because anon-pi owns `--mode` here:
 *   - `--mode text-stream` WITHOUT `-p`/`--print` (watch only makes sense for a
 *     headless run; an interactive pi already streams to its TUI);
 *   - `--mode text-stream` alongside a SECOND `--mode <other>` (ambiguous: which
 *     mode wins?).
 *
 * A NON-text-stream `--mode <x>` is left untouched and forwarded to pi verbatim
 * (anon-pi only claims the `text-stream` value). A trailing bare `--mode` with
 * no value is left for pi to reject.
 */
export function extractWatchMode(piArgs: readonly string[] | undefined): {
	watch: boolean;
	piArgs: string[];
} {
	const args = piArgs ? piArgs.slice() : [];
	// Collect every `--mode <value>` pair so we can tell text-stream from others
	// and catch a duplicate mode.
	let watchAt = -1;
	let otherMode = false;
	for (let i = 0; i < args.length; i++) {
		if (args[i] !== MODE_FLAG) continue;
		const value = args[i + 1];
		if (value === WATCH_MODE_TOKEN) {
			if (watchAt !== -1) {
				throw new AnonPiError(
					`anon-pi: \`${MODE_FLAG} ${WATCH_MODE_TOKEN}\` was given more than once. ` +
						'Pass it exactly once.\nRun `anon-pi --help`.',
				);
			}
			watchAt = i;
		} else if (value !== undefined) {
			otherMode = true;
		}
		i++; // skip the value we just consumed.
	}

	if (watchAt === -1) {
		return {watch: false, piArgs: args};
	}

	if (otherMode) {
		throw new AnonPiError(
			`anon-pi: \`${MODE_FLAG} ${WATCH_MODE_TOKEN}\` cannot be combined with another ` +
				`\`${MODE_FLAG}\`; anon-pi owns the mode for the watch stream.\n` +
				'Run `anon-pi --help`.',
		);
	}

	if (!isHeadlessPiArgs(args)) {
		throw new AnonPiError(
			`anon-pi: \`${MODE_FLAG} ${WATCH_MODE_TOKEN}\` needs a headless run; add \`-p\`. ` +
				'An interactive pi session already streams to its TUI.\nRun `anon-pi --help`.',
		);
	}

	// Strip the `--mode text-stream` pair (flag + value) from the forwarded args.
	args.splice(watchAt, 2);
	return {watch: true, piArgs: args};
}

/**
 * PURE: the pi args to forward INTO the jail for a watch run: the caller's args
 * (already stripped of `--mode text-stream` by extractWatchMode) plus `--mode
 * json`, so pi emits the JSONL event stream anon-pi parses on the host. `-p` is
 * already present (extractWatchMode required it). A `--mode json` is never
 * duplicated (extractWatchMode refuses a pre-existing `--mode`).
 */
export function piArgsForWatch(piArgs: readonly string[]): string[] {
	return [...piArgs, MODE_FLAG, WATCH_PI_MODE];
}

// --- the WATCH stream renderer (pure classifier over pi's `--mode json`) ------
//
// pi's `--mode json` emits a JSONL event stream whose high-signal records are
// `message_end` (a COMPLETED assistant turn) and its `content[]` parts. We render
// at the dorfl `watch-session.ts` granularity: ONE line of assistant text per
// turn, then `\u25b6 <tool>` per tool call. Deltas (`message_update`) and the
// preamble/lifecycle records (`session`/`agent_start`/`turn_*`/`agent_end`) are
// skipped. This is the STREAM vocabulary (`message_end`), distinct from dorfl's
// SESSION-LOG vocabulary (`{type:'message'}`); everything else about the shape
// (content-block walk, defensive parsing) mirrors dorfl.

const WATCH_CYAN = '\u001b[36m';
const WATCH_RESET = '\u001b[0m';

/** Wrap `text` in `code`+reset when `color`, else return it unchanged. */
function watchPaint(text: string, color: boolean, code: string): string {
	return color ? `${code}${text}${WATCH_RESET}` : text;
}

/**
 * PURE: classify ONE pi `--mode json` STREAM line into the high-signal lines to
 * surface, plus (when the line is an assistant `message_end`) the turn's answer
 * text so the caller can track the last one for stdout.
 *
 *   - a `{type:'message_end', message:{role:'assistant', content}}` record => its
 *     `content[]` `text` parts concatenated into ONE line, then `\u25b6 <name>`
 *     per `toolCall` part (name = `name` || `toolName` || `tool`);
 *   - everything else (deltas, user/toolResult messages, lifecycle records,
 *     blank/malformed lines) => no lines.
 *
 * Malformed JSON is skipped (never thrown): a half-written trailing line in a
 * streamed pipe must not crash the renderer. `answer` is the assistant turn's
 * text (or undefined for a non-answer line), so the caller keeps the LAST one.
 */
export function formatWatchStreamLine(
	line: string,
	color: boolean,
): {lines: string[]; answer?: string} {
	const trimmed = line.trim();
	if (trimmed === '') return {lines: []};
	let event: unknown;
	try {
		event = JSON.parse(trimmed);
	} catch {
		return {lines: []}; // half-written line in a live pipe: skip, never throw.
	}
	if (typeof event !== 'object' || event === null) return {lines: []};
	const record = event as {
		type?: unknown;
		message?: {role?: unknown; content?: unknown};
	};
	if (record.type !== 'message_end') return {lines: []};
	const message = record.message;
	if (!message || message.role !== 'assistant') return {lines: []};
	const text = watchAssistantText(message.content);
	const lines = watchAssistantLines(message.content, text, color);
	return text === '' ? {lines} : {lines, answer: text};
}

/**
 * Walk an assistant `message.content` into the surfaced lines: the concatenated
 * `text` as ONE leading line (already computed by watchAssistantText and passed
 * in), then `\u25b6 <name>` per `toolCall` part. A plain-string content yields no
 * tool lines. Mirrors dorfl's `assistantLines`.
 */
function watchAssistantLines(
	content: unknown,
	text: string,
	color: boolean,
): string[] {
	const lines: string[] = [];
	if (Array.isArray(content)) {
		for (const part of content) {
			if (typeof part !== 'object' || part === null) continue;
			const p = part as Record<string, unknown>;
			if (p.type === 'toolCall') {
				const name =
					(typeof p.name === 'string' && p.name !== '' && p.name) ||
					(typeof p.toolName === 'string' && p.toolName !== '' && p.toolName) ||
					'tool';
				lines.push(watchPaint(`\u25b6 ${name}`, color, WATCH_CYAN));
			}
		}
	}
	return text === '' ? lines : [text, ...lines];
}

/**
 * Concatenate the `text` parts of ONE assistant `message.content` (tool/thinking
 * blocks dropped). A plain-string content is itself the text. `''` when there is
 * no text. Mirrors dorfl's `assistantContentText`.
 */
function watchAssistantText(content: unknown): string {
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return '';
	const parts: string[] = [];
	for (const part of content) {
		if (typeof part !== 'object' || part === null) continue;
		const p = part as Record<string, unknown>;
		if (p.type === 'text' && typeof p.text === 'string') parts.push(p.text);
	}
	return parts.join('');
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
	image?: string;
	shell: boolean;
	piArgs: string[];
	fail: (msg: string) => never;
}): ParsedLaunch {
	if (args.shell) {
		args.fail(
			'--shell forwards no pi args (a shell has no session/query). Drop --shell.',
		);
	}
	// Claim `--mode text-stream` (the anon-pi WATCH surface): strip it, and when
	// present rewrite the forwarded args to `--mode json` so pi emits the event
	// stream the CLI renders. extractWatchMode throws (AnonPiError) on a misuse
	// (no `-p`, or a second `--mode`); those propagate as the parse's own errors.
	const {watch, piArgs: stripped} = extractWatchMode(args.piArgs);
	return {
		mode: 'pi',
		machine: args.machine,
		machineExplicit: args.machineExplicit,
		project: undefined,
		mountParent: args.mountParent,
		image: args.image,
		piArgs: watch ? piArgsForWatch(stripped) : stripped,
		watch,
	};
}

/**
 * PURE: parse grammar A into a ParsedLaunch. Consumes the anon-pi flags
 * (`-m <machine>`, `--shell`, `--mount <parent>`, `-i`/`--image <ref>`) LEFT of
 * the project positional; the FIRST bare positional is the project (`.` allowed as
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
 * it is NOT name-validated here.
 *
 * ANY flag anon-pi does not itself own, seen in the no-project position, is
 * FORWARDED to pi verbatim (that flag + everything after it), so `anon-pi -p
 * "hi"` == `anon-pi pi -p "hi"` and `anon-pi --model x` == `anon-pi pi --model
 * x`. There is no "unknown option" for a flag: anon-pi captures its own flags
 * (`-m`/`--machine`, `--shell`, `--mount`, `-i`/`--image`) and hands everything
 * else to pi (pi rejects a genuinely bogus flag itself). The explicit `pi`
 * token still works as before for clarity. Throws AnonPiError only for a missing
 * `-m`/`--mount` argument, a RETIRED `--keep`/`--rm` flag, or a bad name.
 */
export function parseLaunchArgs(args: readonly string[]): ParsedLaunch {
	let machine = DEFAULT_MACHINE;
	let machineSet = false;
	let shell = false;
	let mountParent: string | undefined;
	let image: string | undefined;
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
		if (a === '-i' || a === '--image') {
			// The EPHEMERAL per-launch image override. A raw ref, NOT a
			// name-namespaced anon-pi token (it resolves in netcage's private
			// image store, so any podman ref / `anon-pi/<name>:latest` snapshot tag
			// is valid): not name-validated here. It never mutates machine.json.
			const v = args[++i];
			if (v === undefined) fail(`${a} needs an image ref`);
			image = v as string;
			continue;
		}
		if ((RETIRED_LAUNCH_FLAGS as readonly string[]).includes(a)) {
			// `--keep`/`--rm` are retired (ADR-0004): throwaway is the only
			// behaviour now. Point at the image-based replacement.
			fail(retiredKeepRmMessage(a));
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
				image,
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
				image,
				shell,
				piArgs,
				fail,
			});
		}
		if (a.startsWith('-')) {
			// ANY other flag in the no-project position is FORWARDED to pi verbatim
			// (this flag + everything after it), exactly as the explicit `anon-pi pi
			// <args…>` token does. So `anon-pi -p "hello"` == `anon-pi pi -p "hello"`,
			// `anon-pi --model x` == `anon-pi pi --model x`, etc. anon-pi's OWN flags
			// (`-m`/`--machine`, `--shell`, `--mount`, `-i`/`--image`) are matched
			// ABOVE this point, so they are still captured; the RETIRED `--keep`/`--rm`
			// and the NEEDS-PROJECT `--fork`/`--continue` are handled above too (they
			// keep their own errors). Only genuinely unrecognised-by-anon-pi flags fall
			// through here and go to pi (pi rejects the truly bogus ones itself).
			return finishPiNoProjectLaunch({
				machine,
				machineExplicit: machineSet,
				mountParent,
				image,
				shell,
				piArgs: args.slice(i),
				fail,
			});
		}
		// the first bare positional is the project.
		project = validateName(a, 'project');
		i++;
		break;
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
			image,
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
			image,
		};
	}

	// pi mode: every token after the project is forwarded to pi verbatim, EXCEPT
	// the anon-pi-owned `--mode text-stream` (the WATCH surface), which is stripped
	// here and turns into `--mode json` + the watch flag (extractWatchMode throws
	// on a misuse: no `-p`, or a second `--mode`).
	if (rest.length > 0) piArgs = rest.slice();
	const {watch, piArgs: stripped} = extractWatchMode(piArgs);
	return {
		mode: 'pi',
		machine,
		machineExplicit: machineSet,
		project,
		mountParent,
		image,
		// No piArgs => keep it undefined (a bare interactive launch). Watch =>
		// inject `--mode json`. Otherwise forward the stripped args verbatim.
		piArgs:
			piArgs === undefined
				? undefined
				: watch
					? piArgsForWatch(stripped)
					: stripped,
		watch,
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
 *   - --rm on every THROWAWAY launch (throwaway is the default; ADR-0004).
 *
 * The one PARAMETER on this is intent.durable (the explicit `container` noun):
 * when set, the launch is a DURABLE named box - `--rm` is OMITTED (the box
 * survives exit), the container is `--name`d by durable.name (so `container
 * enter` can `netcage start <name>`), and the `anon-pi.container` label carries
 * the name (so `container list`/`rm` read boxes back). This is the deliberate,
 * OPT-IN reintroduction of the retired `--keep` (the container ADR supersedes
 * ADR-0004's "lost capability" note): a durable box is STILL fully jailed - the
 * two invariant mounts + forced egress are composed IDENTICALLY, never weakened.
 * It is NOT a forked launch path: the one composition below just omits `--rm`
 * and adds the name + label when durable.
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

	const durable = intent.durable;
	const netcageArgs: string[] = ['run'];
	if (durable === undefined) {
		// THROWAWAY (the default): `--rm` removes the container on exit (ADR-0004).
		// Non-durable state is image-based (snapshot + a pinned machine).
		netcageArgs.push('--rm');
	} else {
		// DURABLE (the explicit `container` noun): NO `--rm` (the box survives
		// exit). Name it so `container enter` can `netcage start <name>`, and stamp
		// the durable-box label (the name) so `container list`/`rm` read it back.
		// EVERYTHING ELSE below (mounts, forced egress, seed, cwd, image) is the
		// SAME as a throwaway launch: a durable box is still fully jailed.
		netcageArgs.push('--name', durable.name);
		netcageArgs.push('--label', `${ANON_PI_CONTAINER_LABEL}=${durable.name}`);
	}
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

// --- The per-launch identity label (for `forward`/`ports`/`snapshot`) --------
//
// anon-pi stamps an identity key onto EVERY launch's container (an additive
// netcage label; see withKeyLabel in cli.ts). It is NOT a kept-container match
// key (there are no kept containers: every launch is throwaway, ADR-0004). Its
// sole job is to let `forward`/`ports`/`snapshot` find a RUNNING container and
// read back which machine + project it hosts (parseKeptKey -> keyProject),
// while the container is up (the label goes away with the `--rm` container on
// exit). netcage's `netcage.managed` label marks the container managed; this
// adds anon-pi's own identity on top. anon-pi invents NO registry file.

/**
 * PURE: the anon-pi launch-identity key stamped on EVERY (throwaway) launch,
 * derived from the (machine, projects-root, project) identity (ADR-0002's
 * cwd/project reasoning still underpins it). It is NOT a kept-container MATCH
 * key (every launch is throwaway; nothing is ever resumed). It exists ONLY so
 * `forward`/`ports`/`snapshot` can resolve a RUNNING container by machine +
 * project: the CLI stamps it onto a netcage label and reads it back with
 * parseKeptKey -> keyProject.
 *
 * The fields, and why each is retained:
 *   - `machine.name`: the forward/ports filter scopes by machine.
 *   - `cwd` (the resolved container cwd, via launchCwd): encodes the project
 *     token (`/projects/<p>`, `/work/<p>`, or a root), so keyProject can name
 *     the project a running container hosts.
 *   - `projectsRoot` + `mountParent`: kept in the record for stability of the
 *     decode shape (parseKeptKey reads them best-effort); no consumer filters on
 *     them today, but they cost nothing and keep the label self-describing.
 *
 * Independent of the forced-egress inputs and forwarded pi args (identity only).
 * The key is a single opaque string (a `\n`-joined, field-tagged record) the CLI
 * stamps verbatim onto a netcage label; its internal shape is not a contract
 * (decode only with parseKeptKey).
 */
export function launchIdentityKey(intent: LaunchIntent): string {
	const {machine, mode, projectsRoot, project, mountParent} = intent;
	const mounted = nonEmpty(mountParent) !== undefined;
	const rootKind: RootKind = mounted ? 'mount' : 'projects';
	// The same cwd resolution resolveRunPlan uses, so keyProject names the exact
	// project the running container hosts (its conversation key).
	const cwd = launchCwd(mode, rootKind, project);
	return [
		`machine=${machine.name}`,
		`projectsRoot=${projectsRoot}`,
		`mountParent=${nonEmpty(mountParent) ?? ''}`,
		`cwd=${cwd}`,
	].join('\n');
}

// --- `forward` / `ports`: reach an in-jail server from the host --------------
//
// netcage owns two host-access verbs (>= 0.9.0): `netcage forward <container>
// [<hostPort>:]<jailPort>` stands up ONE host->jail inbound forward, and `netcage
// ports <container> --json` lists the jail's TCP LISTEN sockets image-independently
// (it reads the sidecar's /proc/net/tcp*, so a minimal image with no ss/netstat/nc
// still works). anon-pi wraps them so the user never handles the raw netcage
// container name: it resolves the RUNNING anon-pi container(s) by the identity key
// it stamps on EVERY launch (withKeyLabel + launchIdentityKey), disambiguates with
// a picker annotated by the open listeners, and shells out to `netcage forward`.
// The forced-egress invariant is untouched: `forward` adds no OUTPUT rule (ADR-0014)
// and `ports` only reads /proc; anon-pi composes neither egress flag here.

/**
 * PURE: the decoded fields of a stamped launchIdentityKey (the reverse of
 * launchIdentityKey's `k=v\n` record). Used by `forward`/`ports` to filter the
 * running managed containers by machine + project WITHOUT reconstructing the
 * exact key (which would couple to launchCwd). Unknown/missing fields are ''.
 */
export interface KeptKeyFields {
	machine: string;
	projectsRoot: string;
	mountParent: string;
	cwd: string;
}

/** PURE: parse a stamped launchIdentityKey back into its fields (best-effort). */
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
 * PURE: pick the RUNNING anon-pi containers a `forward`/`ports`/`snapshot` should
 * offer. Filters the supplied running managed containers (each with its decoded
 * key fields) OPTIONALLY by `machine` (undefined = every machine qualifies, used
 * by `snapshot` where the machine is only a narrowing filter) and OPTIONALLY by
 * `project` (its leaf cwd name). The caller resolves 0 (error) / 1 (auto) / many
 * (picker).
 */
export function resolveManagedMatches(args: {
	containers: readonly ManagedContainer[];
	machine?: string;
	project?: string;
}): ManagedContainer[] {
	const {containers, machine, project} = args;
	return containers.filter((c) => {
		const f = parseKeptKey(c.key);
		if (machine !== undefined && f.machine !== machine) return false;
		if (project !== undefined && keyProject(f) !== project) return false;
		return true;
	});
}

/**
 * A RUNNING netcage-managed container the CLI surfaces to the pure forward/ports
 * resolution: its anon-pi identity `key` (stamped label, decoded), the `ref` to
 * pass to `netcage forward`/`ports` (id or name), and a human `name` for the
 * picker.
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
 * The netcage label a DURABLE box (the `container` noun) is stamped with, its
 * VALUE being the box's name (`ANON_PI_CONTAINER_LABEL=<name>`). Distinct from
 * `anon-pi.key` (the machine+cwd IDENTITY every launch stamps): this label marks
 * a container as an anon-pi DURABLE box and carries its user-chosen name, so
 * `container list`/`rm` enumerate + name boxes off the label with no anon-pi-side
 * registry file (the label IS the record; see the container ADR). A throwaway
 * launch never carries it. resolveRunPlan stamps it (with `--name <name>`) only
 * when intent.durable is set.
 */
export const ANON_PI_CONTAINER_LABEL = 'anon-pi.container';

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
 * caller decodes before matching against a launchIdentityKey. [] on bad JSON.
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

/** A durable box (the `container` noun) as `container list`/`enter`/`rm` read it back off the `anon-pi.container` label. */
export interface ContainerBox {
	/** The box's user-chosen name (the `anon-pi.container` label VALUE). */
	name: string;
	/** The netcage container Id (what `netcage start`/`rm` take). */
	ref: string;
	/** True when the container's State is "running" (a live instance, not a stopped box). */
	running: boolean;
	/**
	 * The RAW base64 `anon-pi.key` identity label (machine + cwd), or '' when a box
	 * carries none (an older box, or one stamped before the key label existed).
	 * `container list` DECODES it (Buffer + parseKeptKey) to show the box's machine
	 * and cwd/project WITHOUT a separate query — the label IS the record (the
	 * container ADR: no anon-pi-side registry file). Kept RAW here so the parser
	 * stays pure (the base64 decode is the CLI's job, matching parseNetcagePsJson).
	 */
	key: string;
}

/**
 * PURE: parse `netcage ps -a --format json` into the anon-pi DURABLE BOXES:
 * exactly the entries carrying an `anon-pi.container` label (its VALUE is the
 * box's name), each as {name, ref: <Id>, running: State === "running"}. Unlike
 * parseNetcagePsJson (which keys on `anon-pi.key`, the machine+cwd identity of
 * EVERY launch), this keys on `anon-pi.container`, the label ONLY a durable box
 * carries (see the container ADR: the label IS the record, no registry file). A
 * throwaway launch, a sidecar, and a netcage-only container are all dropped. The
 * caller passes `-a` so BOTH running and stopped boxes are seen (create's
 * dup-check and enter's running-refusal both need the stopped ones). [] on bad
 * JSON / a non-array.
 */
export function parseContainerBoxesJson(stdout: string): ContainerBox[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	const out: ContainerBox[] = [];
	for (const e of parsed) {
		if (!e || typeof e !== 'object') continue;
		const entry = e as NetcagePsEntry;
		const labels = entry.Labels;
		if (!labels || typeof labels !== 'object') continue;
		const name = labels[ANON_PI_CONTAINER_LABEL];
		if (typeof name !== 'string' || name === '') continue; // not a durable box
		const ref = typeof entry.Id === 'string' ? entry.Id : '';
		if (ref === '') continue;
		const rawKey = labels[ANON_PI_KEY_LABEL];
		const key = typeof rawKey === 'string' ? rawKey : '';
		out.push({name, ref, running: entry.State === 'running', key});
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
 * ONE session group a snapshot's `--create-machine` carry-over can offer: a `sessions/<slug>/`
 * dir in the source home. `project` is the project name when the slug matches a
 * known project's `projectSessionSlug` (else undefined: an ORPHAN slug with no
 * matching project, still offered, labelled by its raw slug so nothing hides).
 * `label` is the human row text. `slug` is the exact dir name to copy/delete.
 */
export interface SnapshotSessionGroup {
	slug: string;
	project?: string;
	label: string;
}

/**
 * PURE: the cpSync filter predicate for a snapshot's "copy the home MINUS the
 * sessions subtree" copy: true = copy `src`, false = skip it. It rejects the
 * sessions dir itself and everything beneath it (`<sessionsDir>` and
 * `<sessionsDir>/...`), and copies everything else. Extracted so the
 * home-minus-sessions contract is unit-testable without the fs.
 */
export function copyIncludesForHomeMinusSessions(
	src: string,
	sessionsDir: string,
): boolean {
	return src !== sessionsDir && !src.startsWith(sessionsDir + '/');
}

/**
 * PURE: map the session-dir slugs PRESENT under a source machine's `sessions/`
 * to per-project rows a snapshot's carry-over picker offers. For each present
 * slug, if it equals `projectSessionSlug(<project>)` for a known project, it is a
 * PROJECT row (labelled by the project name); otherwise an ORPHAN-slug row
 * (labelled by the raw slug, so a session with no current project folder is
 * still shown, never silently dropped). Rows are sorted: named projects first
 * (case-insensitive by name), then orphan slugs (by slug), for a stable picker.
 * The caller (CLI) does the actual copy/delete of each chosen slug dir.
 */
export function snapshotSessionGroups(args: {
	presentSlugs: readonly string[];
	projects: readonly string[];
}): SnapshotSessionGroup[] {
	const slugToProject = new Map<string, string>();
	for (const p of args.projects) {
		// projectSessionSlug validates the name; a bad project name throws, which is
		// correct (the projects list comes from real folder names).
		slugToProject.set(projectSessionSlug(p), p);
	}
	const rows: SnapshotSessionGroup[] = args.presentSlugs.map((slug) => {
		const project = slugToProject.get(slug);
		return project !== undefined
			? {slug, project, label: project}
			: {slug, label: `${slug}  (no current project folder)`};
	});
	const lc = (s: string): string => s.toLowerCase();
	return rows.sort((a, b) => {
		// named projects before orphan slugs; within each, by their label key.
		const an = a.project !== undefined ? 0 : 1;
		const bn = b.project !== undefined ? 0 : 1;
		if (an !== bn) return an - bn;
		const ak = lc(a.project ?? a.slug);
		const bk = lc(b.project ?? b.slug);
		return ak < bk ? -1 : ak > bk ? 1 : 0;
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
 * `netcage verify` prints the jail's forced-egress exit IP (in the
 * `forced-egress-exit-ip-differs-from-host` assertion) as PROOF the egress
 * leaves via the proxy, not the host IP.
 *
 * IMPORTANT: `netcage verify` ALSO prints the proxy URL on its FIRST line
 * (`proxy: socks5h://127.0.0.1:9050`). A naive "first IPv4 in the output" scan
 * therefore returned the loopback PROXY address, not the exit IP - a field bug
 * (anon-pi@0.21.0) that showed `Exit IP: 127.0.0.1` and scared users into
 * thinking anonymization had failed. So we SKIP any line that is the proxy line
 * (starts with `proxy:` / carries the `socks5h://` scheme) before scanning, and
 * take the first plausible IP literal from the REMAINING lines. undefined if
 * none is found (the caller then shows netcage's raw output and lets the user
 * judge). This is a best-effort PARSE of another tool's text, kept pure + tested
 * so a format tweak is caught by a unit test, not only in the field.
 *
 * The durable fix is a machine-readable `netcage verify --json` that anon-pi
 * consumes instead of scraping prose (idea `netcage-verify-json-output`); this
 * parser is the stopgap until that lands.
 */
export function parseVerifyExitIp(output: string): string | undefined {
	// Drop the proxy line(s): they carry the (often loopback) PROXY address,
	// which is NOT the exit IP. Match the label `proxy:` or the socks scheme.
	const scanned = output
		.split('\n')
		.filter((line) => {
			const l = line.trimStart();
			return !/^proxy:/i.test(l) && !/socks5h?:\/\//i.test(l);
		})
		.join('\n');
	// IPv4 first (the common case: ipify returns an IPv4 for most exits).
	const v4 = scanned.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
	if (v4) {
		const ip = v4[0];
		if (ip.split('.').every((o) => Number(o) <= 255)) return ip;
	}
	// IPv6 (a loose match: at least two groups and a colon-run), best-effort.
	const v6 = scanned.match(/\b(?:[0-9a-fA-F]{0,4}:){2,}[0-9a-fA-F]{0,4}\b/);
	if (v6 && v6[0].includes('::')) return v6[0];
	if (v6 && v6[0].split(':').filter(Boolean).length >= 3) return v6[0];
	return undefined;
}

/**
 * The netcage verify assertion that IS the anonymity guarantee: the jail's
 * forced-egress exit IP differs from the host IP (egress really leaves via the
 * proxy, not the host). This is the ONE assertion `init` treats as load-bearing;
 * every other netcage assertion (e.g. `dns-resolves-over-tcp-glibc`) is about
 * in-jail FUNCTIONALITY, not about whether the proxy anonymizes.
 */
export const NETCAGE_EGRESS_ASSERTION =
	'forced-egress-exit-ip-differs-from-host';

/**
 * PURE: did netcage verify PROVE the anonymity guarantee, i.e. is there a
 * `[PASS] forced-egress-exit-ip-differs-from-host` line in its output? This is a
 * TARGETED scan for ONE named PASS line, NOT general prose-parsing: it lets
 * `init` distinguish "the proxy does not anonymize" (this returns false -> MUST
 * block) from "the proxy anonymizes but some OTHER netcage check failed" (this
 * returns true even when `netcage verify` exited non-zero -> `init` may offer a
 * deliberate proceed-anyway, since the anonymity proof itself held). Returns
 * false when the assertion is absent or marked `[FAIL]`. The exact assertion id
 * is asserted by a unit test, so a netcage rename is caught here, not in the
 * field.
 */
export function verifyEgressAssertionPassed(output: string): boolean {
	for (const line of output.split('\n')) {
		const l = line.trim();
		if (!l.includes(NETCAGE_EGRESS_ASSERTION)) continue;
		// The assertion line is present; it counts ONLY when marked PASS.
		if (/^\[PASS\]/i.test(l)) return true;
	}
	return false;
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
 * `hardened` is written ONLY when true (a normal install omits it, so a browsed
 * config.json stays clean; absent = non-hardened).
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
	if (config.hardened === true) out.hardened = true;
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
 *
 * Snapshot moved OFF the `machine` noun to the `image` noun (ADR-0003): see
 * `parseImageArgs` / ImageCommand.
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

// --- the `image` noun (ADR-0003): snapshot a running container into a clean
// image tag with provenance labels, and a read-only list of anon-pi images. The
// grammar parse, the clean tag derivation, the provenance-label build, and the
// label read-back parse are all PURE here; the CLI does the netcage commit /
// images / inspect I/O.

/**
 * A parsed `image <verb> …` command (ADR-0003 §1). A discriminated union so the
 * CLI dispatches on `verb` with already-validated fields:
 *   - `snapshot <name> [-m <machine>] [--create-machine <m>|--update-machine <m>]`:
 *     commit the RUNNING container into `anon-pi/<name>:latest`. `name` is a
 *     validated image name (a safe tag segment). `-m <machine>` is an OPTIONAL
 *     filter (which running container to commit when several are up), NOT a
 *     required source. `--create-machine <m>` ALSO creates NEW machine <m> from
 *     the fresh snapshot (running the home-copy + session carry-over).
 *     `--update-machine <m>` instead RE-PINS an EXISTING machine <m> to the fresh
 *     snapshot (no home copy: the home is already the right one). The two are
 *     mutually exclusive.
 *   - `list`: no args (read-only; zero stored state).
 */
export type ImageCommand =
	| {
			verb: 'snapshot';
			name: string;
			machine?: string;
			createMachine?: string;
			updateMachine?: string;
	  }
	| {verb: 'list'};

/**
 * PURE: parse the tokens AFTER `image` into an ImageCommand. Validates the image
 * name + the `-m` / `--create-machine` / `--update-machine` machine names via
 * validateName (the reserved-name / traversal guard), so the CLI only ever joins
 * safe segments. Throws AnonPiError (printed verbatim, exit 1) for an
 * unknown/missing verb, a missing or extra positional, an unknown flag, a bad
 * name, or `--create-machine` + `--update-machine` together (mutually exclusive).
 *
 * `<name>` is validated with the `machine` kind: it shares the same
 * folder-safe / reserved-name rules, and a snapshot name is an image-tag
 * segment (`anon-pi/<name>:latest`), so the same guard applies.
 */
export function parseImageArgs(args: readonly string[]): ImageCommand {
	const fail = (msg: string): never => {
		throw new AnonPiError(
			`anon-pi: ${msg}\nRun \`anon-pi image --help\` or \`anon-pi --help\`.`,
		);
	};

	const verb = args[0];
	if (verb === undefined) {
		fail('`image` needs a subcommand: snapshot | list');
	}

	const rest = args.slice(1);

	if (verb === 'list') {
		if (rest.length > 0)
			fail(`image list takes no arguments, got: ${rest.join(' ')}`);
		return {verb: 'list'};
	}

	if (verb === 'snapshot') {
		let name: string | undefined;
		let machine: string | undefined;
		let createMachine: string | undefined;
		let updateMachine: string | undefined;
		for (let i = 0; i < rest.length; i++) {
			const a = rest[i];
			if (a === '-m' || a === '--machine') {
				const v = rest[++i];
				if (v === undefined) fail(`${a} needs a machine name`);
				machine = validateName(v as string, 'machine');
				continue;
			}
			if (a === '--create-machine') {
				const v = rest[++i];
				if (v === undefined) fail('--create-machine needs a machine name');
				createMachine = validateName(v as string, 'machine');
				continue;
			}
			if (a === '--update-machine') {
				const v = rest[++i];
				if (v === undefined) fail('--update-machine needs a machine name');
				updateMachine = validateName(v as string, 'machine');
				continue;
			}
			if (a.startsWith('-')) fail(`unknown option: ${a}`);
			if (name !== undefined)
				fail(`image snapshot takes one <name>, got extra: ${a}`);
			name = validateName(a, 'machine');
		}
		if (name === undefined) fail('image snapshot needs a <name>');
		if (createMachine !== undefined && updateMachine !== undefined)
			fail(
				'--create-machine and --update-machine are mutually exclusive ' +
					'(one creates a NEW machine, the other re-pins an EXISTING one)',
			);
		return {
			verb: 'snapshot',
			name: name as string,
			machine: nonEmpty(machine),
			createMachine: nonEmpty(createMachine),
			updateMachine: nonEmpty(updateMachine),
		};
	}

	return fail(`unknown image subcommand: ${verb} (snapshot | list)`);
}

// --- the `container` noun: explicit DURABLE named boxes (create/enter/list/rm).
// The deliberate, opt-in reintroduction of the retired `--keep` (the container
// ADR supersedes ADR-0004's "lost capability" note): a durable box is a netcage
// run WITHOUT `--rm` the user NAMES, so there is no create-vs-enter inference.
// `create` freezes the box's image + cwd at create (so it takes the cwd mode
// word); `enter` takes ONLY the name (image + cwd frozen) and REFUSES `-i` /
// project / `--shell` grammatically. The parse is PURE here; the impure verb
// bodies (create/enter, list/rm) land in the sibling tasks.

/**
 * A parsed `container <verb> …` command. A discriminated union so the CLI
 * dispatches on `verb` with already-validated fields:
 *   - `create <name> [-i <ref>] [-m <machine>] [--mount <p>] [<project>|--shell]`:
 *     instantiate a durable box. `name` is a validated box name. The cwd mode
 *     word (a `project` token - a name or the `.` root - OR `--shell`) is FROZEN
 *     at create (the box's cwd is its stable identity); the two are mutually
 *     exclusive. `-i`/`-m`/`--mount` mirror the launch grammar (`-i` an ephemeral
 *     image ref - NOT name-validated - `-m` the HOME machine, `--mount` a HOST
 *     parent path).
 *   - `enter <name>`: re-enter the box. Takes ONLY the name; `-i` and a
 *     project/`--shell` are grammatically REFUSED (both frozen at create), so
 *     the impure enter body owns no such logic.
 *   - `list`: no args (reads boxes off the `anon-pi.container` label; zero state).
 *   - `rm <name> [--yes]`: remove a box (`--yes`/`-y` skips the confirm).
 */
export type ContainerCommand =
	| {
			verb: 'create';
			name: string;
			machine?: string;
			image?: string;
			mountParent?: string;
			shell: boolean;
			project?: string;
	  }
	| {verb: 'enter'; name: string}
	| {verb: 'list'}
	| {verb: 'rm'; name: string; yes: boolean};

/**
 * PURE: parse the tokens AFTER `container` into a ContainerCommand. Validates the
 * box name via validateName (the reserved-name / traversal guard). Throws
 * AnonPiError (printed verbatim, exit 1) for an unknown/missing verb, a missing
 * or extra positional, an unknown flag, a bad name, or - on `enter` - any of the
 * frozen-at-create tokens (`-i`, a project, `--shell`), with a message pointing
 * at re-create / `image snapshot` (the enter body relies on this refusal).
 *
 * `create`'s cwd mode word mirrors the launch grammar: a bare positional is a
 * project (`.` allowed as the root token), `--shell` is the shell mode word, and
 * the two are mutually exclusive (a box has ONE frozen cwd).
 */
export function parseContainerArgs(args: readonly string[]): ContainerCommand {
	const fail = (msg: string): never => {
		throw new AnonPiError(
			`anon-pi: ${msg}\nRun \`anon-pi container --help\` or \`anon-pi --help\`.`,
		);
	};

	const verb = args[0];
	if (verb === undefined) {
		fail('`container` needs a subcommand: create | enter | list | rm');
	}

	const rest = args.slice(1);

	if (verb === 'list') {
		if (rest.length > 0)
			fail(`container list takes no arguments, got: ${rest.join(' ')}`);
		return {verb: 'list'};
	}

	if (verb === 'create') {
		let name: string | undefined;
		let machine: string | undefined;
		let image: string | undefined;
		let mountParent: string | undefined;
		let shell = false;
		let project: string | undefined;
		const setCwdMode = (word: 'shell' | string): void => {
			// The cwd is FROZEN at create: exactly ONE mode word (a project or
			// --shell), never both, so the box has one stable identity.
			if (shell || project !== undefined)
				fail(
					'container create takes ONE cwd mode word: a project or --shell, not both',
				);
			if (word === 'shell') shell = true;
			else project = word;
		};
		for (let i = 0; i < rest.length; i++) {
			const a = rest[i];
			if (a === '-m' || a === '--machine') {
				const v = rest[++i];
				if (v === undefined) fail(`${a} needs a machine name`);
				machine = validateName(v as string, 'machine');
				continue;
			}
			if (a === '-i' || a === '--image') {
				// The EPHEMERAL per-launch image override (frozen into the box). A raw
				// ref resolved in netcage's private store, NOT a name token: not
				// name-validated (mirrors the launch grammar's `-i`).
				const v = rest[++i];
				if (v === undefined) fail(`${a} needs an image ref`);
				image = v as string;
				continue;
			}
			if (a === '--mount') {
				const v = rest[++i];
				if (v === undefined) fail('--mount needs a HOST parent path');
				mountParent = v as string;
				continue;
			}
			if (a === '--shell') {
				setCwdMode('shell');
				continue;
			}
			if (a === ROOT_TOKEN) {
				// the root token is a valid cwd mode word (the root itself), not a name.
				if (name === undefined)
					fail('container create needs a <name> before the cwd mode word');
				setCwdMode(ROOT_TOKEN);
				continue;
			}
			if (a.startsWith('-')) fail(`unknown option: ${a}`);
			if (name === undefined) {
				name = validateName(a, 'project');
				continue;
			}
			// a second bare positional after the name is the project cwd mode word.
			if (shell || project !== undefined)
				fail(`container create got extra argument: ${a}`);
			setCwdMode(validateName(a, 'project'));
		}
		if (name === undefined) fail('container create needs a <name>');
		return {
			verb: 'create',
			name: name as string,
			machine: nonEmpty(machine),
			image: nonEmpty(image),
			mountParent: nonEmpty(mountParent),
			shell,
			project,
		};
	}

	if (verb === 'enter') {
		// The image + cwd are FROZEN at create, so enter takes ONLY the name. `-i`
		// and a project/`--shell` are REFUSED (not silently ignored): the refusal is
		// the whole grammatical guarantee the enter body relies on.
		const refuseFrozen = (what: string): never =>
			fail(
				`container enter takes only a <name>: ${what} is FROZEN at create and ` +
					'cannot be changed on enter. Re-create the box under a new name (a new ' +
					'name is a new box), or `anon-pi image snapshot` it and launch the image.',
			);
		let name: string | undefined;
		for (let i = 0; i < rest.length; i++) {
			const a = rest[i];
			if (a === '-i' || a === '--image') refuseFrozen('the image (`-i`)');
			if (a === '--shell') refuseFrozen('the cwd (`--shell`)');
			if (a === ROOT_TOKEN) refuseFrozen('the cwd (a project/`.`)');
			if (a.startsWith('-')) fail(`unknown option: ${a}`);
			if (name === undefined) {
				name = validateName(a, 'project');
				continue;
			}
			// a second bare positional is the (refused) frozen cwd mode word.
			refuseFrozen('the cwd (a project/`.`)');
		}
		if (name === undefined) fail('container enter needs a <name>');
		return {verb: 'enter', name: name as string};
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
				fail(`container rm takes one name, got extra: ${a}`);
			name = validateName(a, 'project');
		}
		if (name === undefined) fail('container rm needs a <name>');
		return {verb: 'rm', name: name as string, yes};
	}

	return fail(
		`unknown container subcommand: ${verb} (create | enter | list | rm)`,
	);
}

/**
 * PURE: the clean image tag a `image snapshot <name>` writes:
 * `anon-pi/<name>:latest`. A same-name re-snapshot OVERWRITES this tag (that is
 * what `:latest` means); the previous image becomes dangling but keeps its
 * provenance label. The name is a validated image/machine name (a safe
 * image-path segment).
 */
export function snapshotImageTag(name: string): string {
	return `anon-pi/${validateName(name, 'machine')}:latest`;
}

/** The podman/anon-pi provenance label keys baked into a snapshot image. */
export const PROVENANCE_LABEL_SOURCE_MACHINE = 'anon-pi.source-machine';
export const PROVENANCE_LABEL_SOURCE_IMAGE = 'anon-pi.source-image';
export const PROVENANCE_LABEL_SNAPSHOT_AT = 'anon-pi.snapshot-at';

/**
 * PURE: build the `LABEL k=v` change instructions a `netcage commit -c '…'`
 * bakes into a snapshot image (ADR-0003 §2). Provenance is best-effort HISTORY:
 * a label whose value is undefined/empty is OMITTED (a missing label beats a
 * wrong one). `at` is required (the snapshot time is always known). Each string
 * is ONE `LABEL key=value` instruction (the CLI passes each as a `-c` argv
 * element; podman round-trips `/` and `:` in the value un-quoted, verified).
 */
export function snapshotProvenanceLabels(args: {
	sourceMachine?: string;
	sourceImage?: string;
	at: string;
}): string[] {
	const labels: string[] = [];
	const push = (key: string, value: string | undefined): void => {
		const v = nonEmpty(value);
		if (v !== undefined) labels.push(`LABEL ${key}=${v}`);
	};
	push(PROVENANCE_LABEL_SOURCE_MACHINE, args.sourceMachine);
	push(PROVENANCE_LABEL_SOURCE_IMAGE, args.sourceImage);
	push(PROVENANCE_LABEL_SNAPSHOT_AT, args.at);
	return labels;
}

/** Provenance read back from a snapshot image's labels (any field may be absent). */
export interface ImageProvenance {
	sourceMachine?: string;
	sourceImage?: string;
	snapshotAt?: string;
}

/**
 * PURE: parse the anon-pi provenance labels read back off an image (the CLI
 * supplies the label map from `inspect --format '{{json .Config.Labels}}'`).
 * Returns only the anon-pi provenance fields (a missing/empty label => an
 * undefined field). Tolerant: any non-string / absent value is dropped, so a
 * hand-edited or partial label set never throws.
 */
export function parseImageProvenance(
	labels: Record<string, unknown> | null | undefined,
): ImageProvenance {
	const get = (key: string): string | undefined => {
		const v = labels?.[key];
		return typeof v === 'string' ? nonEmpty(v) : undefined;
	};
	return {
		sourceMachine: get(PROVENANCE_LABEL_SOURCE_MACHINE),
		sourceImage: get(PROVENANCE_LABEL_SOURCE_IMAGE),
		snapshotAt: get(PROVENANCE_LABEL_SNAPSHOT_AT),
	};
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

// --- The hardened self-re-exec invocation (docs/adr/0006) --------------------
//
// On a HARDENED install anon-pi's whole workspace lives under a single dedicated
// Unix account named `anon` (a DAC discoverability boundary: a host agent running
// as the login user cannot casually `find`/`grep` the session transcripts). There
// is NO wrapper script: anon-pi is its OWN wrapper. When the login user runs
// anon-pi on a hardened box, it RE-EXECS ITSELF as `anon` by SPAWNING `sudo`
// (never setuid, never a raw uid change; anon-pi ships no setuid binary and sets
// no uid). Auto-redirect is ALWAYS on a hardened install (option A): every
// login-user invocation redirects; only a caller that already IS `anon` skips it
// (the loop guard). This module owns ONLY the PURE decision + argv/string
// composition: the "am I anon?" identity probe and the anon-pi path are INJECTED
// seams (like the `exists` probe elsewhere), so nothing here spawns or touches
// the process. cli.ts (a later task) does the actual exec.

/**
 * The DEFAULT persona's dedicated Unix account name (prd
 * `hardened-dedicated-account-deployment`, docs/adr/0006). In v1 this was the
 * ONLY account; multi-persona (prd `multi-persona-hardened-accounts`,
 * superseding ADR-0006) makes it the DEFAULT of N personas: it is the account
 * for the empty-suffix persona (`personaAccount(undefined) === 'anon'`), so an
 * existing v1 install is a multi-persona install with exactly one persona named
 * `anon`. One canonical default name, pinned here so it can never be re-forked
 * (the old idea note drifted `netuser` vs `anon`).
 */
export const ANON_ACCOUNT = 'anon';

/** The injected identity + hardened-flag inputs for the should-redirect predicate. */
export interface RedirectInputs {
	/** Whether THIS install is configured-hardened (runs under the `anon` account). */
	hardened: boolean;
	/**
	 * Whether the current effective user already IS the `anon` account. INJECTED
	 * (the impure `getuid`/username probe lives in cli.ts), so this stays pure.
	 */
	isAnon: boolean;
}

/**
 * PURE: decide whether anon-pi must re-exec itself as the dedicated `anon`
 * account. On a HARDENED install redirect is ALWAYS chosen when the caller is
 * NOT already `anon` (option A: there is no non-hardened bypass on a hardened
 * box). When the caller already IS `anon` it must NOT redirect (else an infinite
 * self-re-exec loop). A non-hardened install never redirects. Both inputs are
 * injected (RedirectInputs), so this calls no `getuid`/`whoami` and spawns
 * nothing; the actual exec is cli.ts's job.
 */
export function shouldRedirectToAnon(inputs: RedirectInputs): boolean {
	if (!inputs.hardened) return false;
	return !inputs.isAnon;
}

/** The injected inputs for the invocation argv/string builders. */
export interface HardenedInvocation {
	/**
	 * The ABSOLUTE path to the anon-pi binary to re-exec (resolved by the caller,
	 * NOT hard-coded here; cli.ts derives it from its own entrypoint). Injected so
	 * the builder stays pure/testable.
	 */
	anonPiPath: string;
	/** The args forwarded verbatim to the re-exec'd anon-pi (the login user's argv tail). */
	forwardedArgs: readonly string[];
	/**
	 * The dedicated persona account to re-exec into. DEFAULTS to ANON_ACCOUNT
	 * (`anon`) so v1's single-account callers stay byte-identical; multi-persona
	 * passes the SELECTED account (`anon-<name>`, from resolvePersonaSelection) so
	 * the crossing lands in the right persona. INJECTED, so this stays pure.
	 */
	account?: string;
}

/**
 * PURE: compose the PRIMARY re-exec argv, the login `-i` form:
 *   `['sudo', '-u', '<account>', '-i', '<abs-anon-pi-path>', ...forwardedArgs]`
 * The account DEFAULTS to `anon` (v1's single account); multi-persona passes the
 * SELECTED persona account (`anon-<name>`), so the crossing lands in the right
 * persona. The `-i` (login) shell so `$HOME`/`$XDG_RUNTIME_DIR`/env become the
 * account's (which rootless podman under a lingering account needs). anon-pi
 * re-execs by SPAWNING
 * `sudo` only: this builder EMITS a plain argv (the first token is always
 * `sudo`), never a uid change or a privilege syscall. The anon-pi path + args are
 * injected. cli.ts spawns this argv; this module never does.
 */
export function buildAnonSudoArgv(inv: HardenedInvocation): string[] {
	return [
		'sudo',
		'-u',
		inv.account ?? ANON_ACCOUNT,
		'-i',
		inv.anonPiPath,
		...inv.forwardedArgs,
	];
}

// --- The as-account workspace-write handoff (hardened `init` / `persona add`) --
//
// On a hardened install the workspace (mode-700 dir + config.json + optionally
// the default machine + models/settings seeds) MUST be written AS the account,
// because the account's home is mode-700 and owned by the account: the login
// user cannot write into it (ADR-0006: "the login user must not write the
// workspace"). anon-pi never setuids; it crosses the SAME way a launch does, by
// SPAWNING `sudo -u <account> -i anon-pi <INIT_APPLY_SUBCOMMAND>` (permitted by
// the scoped sudoers rule, which allows running the anon-pi BINARY as the
// account with any args). The resolved values are handed to the as-account child
// on STDIN (not an argv path + not a temp file): nothing sensitive lands in
// `ps`, there is no world-readable temp window, and the `--force-allow-local-llm
// -api-key` case (whose config carries a real key) does not leak. The child runs
// non-interactively (piped stdin, no TTY) and performs the identical writes it
// would have done locally, into ITS OWN `$HOME/.anon-pi`.

/**
 * The internal subcommand the hardened crossing invokes on the as-account child:
 * `anon-pi __init-apply`. It reads an InitApplyPayload (JSON) on stdin and writes
 * the workspace into the account's own `~/.anon-pi`. INTERNAL (double-underscore,
 * not in help): a human never runs it; only the `sudo -u <account> -i anon-pi`
 * handoff does. Kept as ONE named constant so the emit site + the dispatch site
 * can never drift.
 */
export const INIT_APPLY_SUBCOMMAND = '__init-apply';

/**
 * The JSON payload the login-user side serializes and pipes (on stdin) to the
 * as-account `__init-apply` child. It carries ONLY already-resolved values (the
 * interactive answers are gathered login-side; the child never prompts). Both
 * hardened `init` and hardened `persona add` use it: `persona add` sends only
 * `config` (no machine/models), `init` sends all of it.
 */
export interface InitApplyPayload {
	/** The config.json to write into the account's `~/.anon-pi/config.json`. */
	config: AnonPiConfig;
	/**
	 * `init` only: create/update the `default` machine pinned to this image (absent
	 * / undefined = no machine write, e.g. `persona add`, or an imageless `init`).
	 */
	machineImage?: string;
	/** `init` only: the default machine name to create/pin (`init` passes DEFAULT_MACHINE). */
	machine?: string;
	/** `init` only: the serialized global models.json body (already generated), if any. */
	modelsBody?: string;
	/** `init` only: the model selection (default + enabled) for the global settings seed, if any. */
	selection?: ModelSelection;
}

/**
 * PURE: single-quote a token for a POSIX `sh -c` command string (the `su -c`
 * fallback runs one string through a login shell). Wraps in `'…'` and escapes an
 * embedded single quote as `'\''`, so no space/quote/metacharacter in an
 * injected arg can break out of the command string.
 */
export function shellQuote(token: string): string {
	return `'${token.replace(/'/g, "'\\''")}'`;
}

/**
 * PURE: compose the documented FALLBACK re-exec argv, the
 * `su - <account> -c '<cmd>'` form for boxes where sudoers is not configured:
 *   `['su', '-', '<account>', '-c', "'<abs-anon-pi>' '<arg>' …"]`
 * The account DEFAULTS to `anon` (v1) and is the SELECTED persona account under
 * multi-persona.
 * The command STRING is the shell-quoted anon-pi path followed by each
 * shell-quoted forwarded arg (shellQuote), so the login shell re-runs anon-pi
 * safely. Like the sudo form this only ever EMITS an argv (first token always
 * `su`), never a privilege syscall; the anon-pi path + args are injected.
 */
export function buildAnonSuFallback(inv: HardenedInvocation): string[] {
	const command = [inv.anonPiPath, ...inv.forwardedArgs]
		.map(shellQuote)
		.join(' ');
	return ['su', '-', inv.account ?? ANON_ACCOUNT, '-c', command];
}

// --- Multi-persona: name<->account mapping, --as selection, generalized guard -
//
// v1 hard-coded ONE dedicated account `anon`. Multi-persona (prd
// `multi-persona-hardened-accounts`, superseding ADR-0006) makes it N accounts:
// a user-typed BARE name (`alice`) maps to the namespaced Unix account
// `anon-<name>` (`anon-alice`), and the DEFAULT (empty/absent name) is the bare
// `anon` (the empty-suffix case), so a v1 install is a multi-persona install
// with exactly one persona named `anon` (byte-behaviour-identical default). This
// section is the PURE core only: the mapping + validation, the `--as` selection
// resolver over an INJECTED persona list, and the generalized self-re-exec loop
// guard ("am I the TARGET persona?"). Everything OS-touching (whoami, the real
// persona list, the exec) stays an INJECTED seam wired by later tasks, mirroring
// the v1 hardened style; nothing here spawns, probes, or touches the fs.

/**
 * The account-name PREFIX every persona carries: a bare name `<name>` maps to
 * the Unix account `anon-<name>`. Namespacing (over a bare `<name>` account) is
 * deliberate: a persona `alice` as a bare `alice` account could collide with a
 * real system/human account, whereas `anon-alice` is collision-safe and
 * self-labelling in `/etc/passwd` (it reveals only "this box runs anonymization
 * tooling", already true of v1's `anon`, never persona linkage). The default
 * persona is this prefix with an EMPTY suffix, i.e. the bare `anon`
 * (ANON_ACCOUNT), so `anon-` without a trailing hyphen is the default account.
 */
export const PERSONA_ACCOUNT_PREFIX = 'anon-';

/**
 * PURE: validate a user-facing BARE persona name as a safe Unix-username SUFFIX,
 * returning it TRIMMED on success. The bare name becomes the account
 * `anon-<name>` (personaAccount), so it must be a safe, collision-free suffix.
 *
 * The accepted charset is a conservative Unix-username subset: lowercase
 * `[a-z0-9]` plus internal hyphens, and it must START with an alphanumeric
 * (`^[a-z0-9][a-z0-9-]*$`). This is intentionally NARROWER than the full POSIX
 * portable-username set (no underscore, no `$`, no uppercase): the resulting
 * account is `anon-<name>`, so `<name>` only needs to be a clean, lowercase,
 * hyphen-joinable label; a narrow charset keeps it obviously safe for passwd /
 * sudoers / home-path / the `socks5h://<account>:x@…` Tor isolation username
 * with no quoting surprises.
 *
 * Rejects (with AnonPiError):
 *   - empty / whitespace-only (a name was required, none given);
 *   - a name already carrying the `anon-` prefix (double-prefix -> `anon-anon-…`);
 *   - anything outside `^[a-z0-9][a-z0-9-]*$` (uppercase, `_`, `/`, `\`, `:`,
 *     whitespace, a leading hyphen, ...).
 */
export function validatePersonaName(name: string): string {
	const trimmed = name.trim();
	const bad = (why: string): never => {
		throw new AnonPiError(
			`anon-pi: invalid persona name ${JSON.stringify(name)}: ${why}. ` +
				`A persona name must be a single lowercase label (a-z 0-9 and internal ` +
				`hyphens, starting alphanumeric), with no \`anon-\` prefix (anon-pi adds it).`,
		);
	};
	if (trimmed === '') return bad('it is empty');
	if (trimmed.startsWith(PERSONA_ACCOUNT_PREFIX)) {
		return bad(
			`it already starts with the \`${PERSONA_ACCOUNT_PREFIX}\` account prefix ` +
				`(pass the BARE name; anon-pi maps it to \`${PERSONA_ACCOUNT_PREFIX}<name>\`)`,
		);
	}
	if (!/^[a-z0-9][a-z0-9-]*$/.test(trimmed)) {
		return bad(
			'it is not a safe lowercase Unix-username suffix (a-z 0-9 and internal ' +
				'hyphens only, must start with a-z or 0-9)',
		);
	}
	return trimmed;
}

/**
 * PURE: map a user-facing BARE persona name to its dedicated Unix account. The
 * DEFAULT (undefined / empty / whitespace-only) maps to the bare `anon`
 * (ANON_ACCOUNT) so v1 installs are unchanged; a real name `<name>` maps to
 * `anon-<name>` (via PERSONA_ACCOUNT_PREFIX), validating the bare name first
 * (validatePersonaName) so an invalid name yields a clear error rather than a
 * broken account. The `anon` default is NOT special-cased in provisioning: it is
 * simply the empty-suffix persona.
 */
export function personaAccount(name?: string): string {
	if (name === undefined || name.trim() === '') return ANON_ACCOUNT;
	return PERSONA_ACCOUNT_PREFIX + validatePersonaName(name);
}

/**
 * PURE: the inverse of personaAccount, the BARE persona name a dedicated account
 * carries. The default account `anon` maps back to the DEFAULT (undefined bare
 * name, since the default persona is the empty-suffix one). A namespaced account
 * `anon-<name>` maps to `<name>`. A non-persona account (anything not `anon` and
 * not `anon-<nonempty>`) returns undefined. Used where anon-pi must display the
 * bare name a running account represents.
 */
export function personaName(account: string): string | undefined {
	if (account === ANON_ACCOUNT) return undefined;
	if (
		account.startsWith(PERSONA_ACCOUNT_PREFIX) &&
		account.length > PERSONA_ACCOUNT_PREFIX.length
	) {
		return account.slice(PERSONA_ACCOUNT_PREFIX.length);
	}
	return undefined;
}

/**
 * PURE: is `account` ANY anon persona account, i.e. the default `anon`
 * (ANON_ACCOUNT) OR a namespaced `anon-<name>`? This is the persona-aware
 * generalization of the v1 `account === ANON_ACCOUNT` check: `init`'s hardening
 * step uses it to skip re-asking when it is ALREADY running under a hardened
 * persona account (default OR named), where v1 only recognized the bare `anon`.
 */
export function isAnonPersonaAccount(account: string): boolean {
	return account === ANON_ACCOUNT || personaName(account) !== undefined;
}

/** The persona-selection flag: a plain `--as <name>` (default `anon` when absent). */
export const AS_FLAG = '--as';

/** The injected inputs for the pure `--as` selection resolver. */
export interface PersonaSelectionInputs {
	/**
	 * The launch argv (or any token list) to scan for `--as <name>`. Injected so
	 * the resolver stays pure; the CLI passes the real process argv tail.
	 */
	args: readonly string[];
	/**
	 * The KNOWN persona ACCOUNTS (e.g. `['anon', 'anon-alice']`), injected by the
	 * impure layer (which enumerates the real accounts). When OMITTED the resolver
	 * does NO existence check (there is no persona list to check against, so
	 * `known` is undefined and no unknown-persona error is raised): this task does
	 * no I/O. The default `anon` is always treated as known (it is the built-in
	 * default persona), whether or not a list is injected.
	 */
	personas?: readonly string[];
}

/**
 * The resolved persona selection. Pure data the impure layer acts on: `account`
 * is the selected Unix account (`anon-<name>`, or the default `anon`); `name` is
 * the bare name (undefined for the default); `known` is the existence predicate
 * over the injected persona list (undefined when no list was injected, since
 * this task does no I/O); `error` is a NON-thrown AnonPiError the impure layer
 * surfaces (a `--as` with no value, an invalid name, or an unknown persona), so
 * the caller decides how/when to fail. The resolver never throws for a
 * selection problem: it RETURNS the error so the caller owns the failure.
 */
export interface PersonaSelection {
	/** The selected persona Unix account (`anon-<name>`, or `anon` for the default). */
	account: string;
	/** The bare persona name (`<name>`), or undefined for the default persona. */
	name?: string;
	/**
	 * Whether the selected account is a KNOWN persona, per the injected list.
	 * undefined when no persona list was injected (no existence check performed).
	 */
	known?: boolean;
	/**
	 * A non-thrown selection error for the impure layer to raise (missing `--as`
	 * value, invalid name, or unknown persona), or undefined when the selection is
	 * clean. NOT thrown here so the caller owns when/how to fail.
	 */
	error?: AnonPiError;
}

/**
 * PURE: resolve the persona a launch selects from `--as <name>`, over an
 * INJECTED persona list. Absent `--as` selects the DEFAULT `anon` (byte-behaviour
 * -identical to v1); `--as <name>` selects `anon-<name>`. The resolver does NO
 * I/O: it returns a PersonaSelection (account + bare name + known-predicate +
 * a non-thrown error) the impure layer acts on. The name is a plain argument
 * (accepted: it may appear in argv/history/`ps`).
 *
 * Error cases are REPRESENTED, not thrown (the caller owns failure):
 *   - `--as` with no following value (or a following flag) -> a clear error;
 *   - `--as <name>` with an invalid bare name (charset) -> the validation error;
 *   - `--as <name>` naming a persona NOT in the injected list -> an unknown
 *     -persona error (only when a list is injected; the default `anon` is always
 *     known). `account` is still the resolved `anon-<name>` so the caller can
 *     quote it in a "create it with `anon-pi persona add <name>`" message.
 */
export function resolvePersonaSelection(
	inputs: PersonaSelectionInputs,
): PersonaSelection {
	const {args, personas} = inputs;
	const idx = args.indexOf(AS_FLAG);

	// No --as: the DEFAULT persona `anon`. Known unless a list is injected that
	// somehow omits it (the caller then decides); with no list, always known.
	if (idx === -1) {
		const known = personas ? personas.includes(ANON_ACCOUNT) : true;
		const sel: PersonaSelection = {account: ANON_ACCOUNT};
		if (personas) sel.known = known;
		else sel.known = true;
		return sel;
	}

	const value = args[idx + 1];
	if (value === undefined || value.startsWith('-')) {
		return {
			account: ANON_ACCOUNT,
			error: new AnonPiError(
				`anon-pi: \`${AS_FLAG}\` needs a persona name, e.g. \`${AS_FLAG} alice\`. ` +
					`Omit \`${AS_FLAG}\` for the default persona \`${ANON_ACCOUNT}\`.`,
			),
		};
	}

	let name: string;
	try {
		name = validatePersonaName(value);
	} catch (e) {
		return {
			account: ANON_ACCOUNT,
			error: e instanceof AnonPiError ? e : new AnonPiError(String(e)),
		};
	}

	const account = personaAccount(name);
	if (!personas) return {account, name, known: undefined};

	const known = personas.includes(account);
	const sel: PersonaSelection = {account, name, known};
	if (!known) {
		sel.error = new AnonPiError(
			`anon-pi: no persona \`${name}\` (account \`${account}\`). ` +
				`Create it with \`anon-pi persona add ${name}\`.`,
		);
	}
	return sel;
}

/**
 * PURE: STRIP the persona-selection flag from a launch argv, so netcage (and the
 * launch grammar / subcommand dispatch) NEVER see `--as <name>`. Removes the
 * FIRST `--as` and its following value (the persona name). A trailing `--as`
 * with no value drops the flag alone (the impure layer already raises the
 * missing-value error via resolvePersonaSelection before reaching netcage). An
 * argv with no `--as` is returned unchanged, so the no-`--as` default is
 * byte-identical to v1. Only the FIRST occurrence is stripped: the value after
 * `--as` is a persona name (resolvePersonaSelection reads exactly that first
 * flag), so a stray later `--as` is left for the launch grammar to reject.
 *
 * This is the argv-hygiene half of decision 2: the `--as` value must be stripped
 * from the argv netcage sees, yet SURVIVE into the re-exec (the redirect forwards
 * the RAW argv, and the re-exec'd child strips it here before composing the jail).
 */
export function stripAsFlag(args: readonly string[]): string[] {
	const idx = args.indexOf(AS_FLAG);
	if (idx === -1) return [...args];
	const value = args[idx + 1];
	// Drop the flag, and its value too UNLESS the value is missing / another flag
	// (a malformed `--as` the impure layer errors on first): then drop the flag only.
	const drop = value === undefined || value.startsWith('-') ? 1 : 2;
	return [...args.slice(0, idx), ...args.slice(idx + drop)];
}

/** The injected inputs for the generalized self-re-exec loop guard. */
export interface PersonaRedirectInputs {
	/** Whether THIS install is configured-hardened (runs under a persona account). */
	hardened: boolean;
	/**
	 * The account the current process runs as (from the impure `whoami`/getuid,
	 * INJECTED so this stays pure). v1's `isAnon` boolean generalizes to this
	 * account identity.
	 */
	currentAccount: string;
	/**
	 * The SELECTED persona account this invocation targets (from
	 * resolvePersonaSelection). The default is `anon`, preserving v1.
	 */
	selectedAccount: string;
}

/**
 * PURE: the generalized self-re-exec loop guard. v1 asked "am I `anon`?"
 * (shouldRedirectToAnon); with N personas it asks "am I already the TARGET
 * persona account?". On a HARDENED install, redirect when the current account
 * is NOT the selected persona account, and do NOT when it already IS (the loop
 * guard, else infinite self-re-exec). A non-hardened install never redirects.
 * Because a login-user call selecting the default `anon` has
 * currentAccount != `anon`, this is byte-behaviour-identical to v1's
 * shouldRedirectToAnon for the default persona. A persona is never auto
 * -redirected to a DIFFERENT persona: the impure layer only ever passes the
 * SELECTED account, and once running as it this returns false. Both identities
 * are injected; nothing here spawns or probes.
 */
export function shouldRedirectToPersona(
	inputs: PersonaRedirectInputs,
): boolean {
	if (!inputs.hardened) return false;
	return inputs.currentAccount !== inputs.selectedAccount;
}

// --- Per-persona fail-closed egress: the Tor URL composer + the offer-Tor
// predicate (prd `multi-persona-hardened-accounts`, decisions 3 + 4 + 5,
// superseding ADR-0006) -------------------------------------------------------
//
// v1 had ONE global proxy. Multi-persona gives EACH persona its OWN socks5h
// endpoint, so two personas never share an exit IP (the isolation that matters
// most). There are two ways to obtain a per-persona endpoint:
//   (1) Tor multi-persona: reuse ONE running Tor, but hand it the persona's
//       ACCOUNT NAME as the SOCKS-isolation USERNAME. Tor's `IsolateSOCKSAuth`
//       (on by default) then builds a SEPARATE circuit + exit per distinct SOCKS
//       username, so each persona gets an independent, auto-managed,
//       auto-expiring circuit for free (idle circuits tear down at
//       `MaxCircuitDirtiness` ~600s and rebuild on next use), at near-zero
//       marginal cost (a circuit is state in the one daemon, not a process).
//   (2) bring-your-own socks5h endpoint (a distinct wireproxy / `ssh -D` port).
//
// composeTorPersonaProxy is the PURE composer for path (1): account + host:port
// in, the literal `socks5h://<account>:x@<host:port>` out. `persona add` calls
// it ONCE at creation and stores the result verbatim in the persona's OWN
// config.json `proxy` field (decision 5): after that it is a plain v1 `proxy`
// string read by resolveProxy like any other, with NO launch-time re-derivation
// and NO schema marker. offerTor is the PURE predicate over an INJECTED
// Tor-detection probe (the real probe reuses init's SOCKS / `netcage
// detect-proxy` seam, wired in cli.ts): it decides WHEN `persona add` offers the
// Tor path. Fail-closed per persona is just v1's resolveProxy / PROXY_REQUIRED
// _MESSAGE now reading the PERSONA's own config (the re-exec into the account
// makes `resolveAnonPiHome` land in the persona's home before config is read),
// so a persona with no resolvable proxy REFUSES byte-identically to v1 and never
// falls back to another persona's proxy or to none. Netcage's forced-egress
// invariant is UNCHANGED: still exactly one socks5h forced per launch,
// fail-closed; this only picks WHICH one. No `NETCAGE_GRAPHROOT`. All pure +
// injected: nothing here spawns, probes a socket, or touches the fs.

/**
 * The ignored placeholder PASSWORD in a Tor multi-persona SOCKS URL. Tor's
 * `IsolateSOCKSAuth` isolates on the USERNAME (the persona account); the
 * password is never checked, so a single, obvious placeholder is used. Pinned as
 * a constant so the composer and its test agree and it can never silently drift.
 * (See prd `multi-persona-hardened-accounts` Further Notes: "the password is an
 * ignored placeholder".)
 */
export const TOR_PLACEHOLDER_PASSWORD = 'x';

/**
 * The DEFAULT Tor SOCKS host:port a persona's egress is composed against: the
 * system-tor listener `127.0.0.1:9050` (DEFAULT_SOCKS_PROBE_PORTS' first entry).
 * A custom host:port (e.g. `127.0.0.1:9150` for a Tor Browser bundle) is passed
 * explicitly. Pinned so the composer default and its test agree.
 */
export const DEFAULT_TOR_SOCKS_HOST_PORT = '127.0.0.1:9050';

/**
 * PURE: compose a persona's Tor multi-persona egress URL,
 * `socks5h://<account>:x@<host:port>`, injecting the persona's ACCOUNT NAME as
 * the SOCKS-isolation USERNAME so Tor's `IsolateSOCKSAuth` gives THIS persona its
 * own circuit/exit (two personas on the SAME Tor endpoint get distinct exits
 * purely because their usernames differ). The password is the ignored
 * placeholder `x` (TOR_PLACEHOLDER_PASSWORD). `hostPort` defaults to
 * DEFAULT_TOR_SOCKS_HOST_PORT (`127.0.0.1:9050`) and is normalised via
 * hostPortKey (scheme/path/userinfo stripped), so a caller that passes a full
 * `socks5h://…` URL never yields `socks5h://socks5h://…`.
 *
 * The result is a PLAIN LITERAL socks5h string with NO schema marker: `persona
 * add` stores it verbatim in the persona's own config.json `proxy` field once,
 * and every later launch reads it as an ordinary v1 `proxy` (resolveProxy).
 * There is NO launch-time re-derivation. Pure: account + host:port in, string
 * out; nothing here probes Tor or touches the fs.
 *
 * The account must be non-empty (there is no isolation username to inject
 * otherwise): an empty/whitespace-only account throws AnonPiError. The account
 * is expected to already be a validated persona account (personaAccount), so no
 * further charset validation is done here.
 */
export function composeTorPersonaProxy(
	account: string,
	hostPort: string = DEFAULT_TOR_SOCKS_HOST_PORT,
): string {
	const acct = account.trim();
	if (acct === '') {
		throw new AnonPiError(
			'anon-pi: cannot compose a Tor persona proxy without a persona account ' +
				'(the account is the SOCKS-isolation username).',
		);
	}
	return `socks5h://${acct}:${TOR_PLACEHOLDER_PASSWORD}@${hostPortKey(hostPort)}`;
}

/**
 * The INJECTED Tor-detection probe RESULT `offerTor` decides over: whether a
 * SOCKS port responded (`open`) and whether it spoke SOCKS5 (`socks5`). This is
 * the shape the impure probe in cli.ts produces by reusing init's SOCKS handshake
 * / `netcage detect-proxy` seam (a ProxyFinding's `open` + `handshake.socks5`,
 * or a NetcageDetectProxy candidate's `open` + `socks5`, collapsed to this pair).
 * Kept as a tiny explicit shape so the pure predicate never depends on the full
 * probe machinery. `undefined` represents "no detection performed".
 */
export interface TorDetection {
	/** Whether the probed Tor SOCKS port was open (a TCP connection succeeded). */
	open: boolean;
	/** Whether the open port completed a SOCKS5 handshake (only meaningful when open). */
	socks5?: boolean;
}

/**
 * PURE: decide whether `persona add` should OFFER the Tor multi-persona path,
 * over an INJECTED Tor-detection probe result. Offer Tor ONLY when a running Tor
 * SOCKS proxy was actually observed: the port is open AND it completed a SOCKS5
 * handshake. A closed port, an open-but-not-SOCKS5 port, or no detection at all
 * (`undefined`) does NOT offer Tor (the user falls through to the bring-your-own
 * SOCKS path). This never guesses: it offers Tor only on positive evidence, and
 * the ACTUAL egress is still fail-closed (a persona with no resolved proxy
 * refuses, whether or not Tor was offered). Pure: it decides only over the
 * injected result; the socket/`netcage` probe is cli.ts's job.
 */
export function offerTor(detection: TorDetection | undefined): boolean {
	return detection !== undefined && detection.open && detection.socks5 === true;
}

// --- The Tier-2 root-provisioning COMMAND generator (prd
// `multi-persona-hardened-accounts`, decisions 0 + 8, superseding ADR-0006) ----
//
// The hardened deployment splits its setup into two tiers: Tier 1 (rootless)
// anon-pi does itself; Tier 2 (root) anon-pi must NEVER do silently. So anon-pi
// GENERATES the root-requiring steps and PRINTS them; the HUMAN runs them. v1
// emitted a `#!/bin/sh` script FILE the human saved + ran with sudo. This is
// RETIRED (for both the default `anon` and every `anon-<name>` persona): anon-pi
// now emits COPY-PASTE COMMANDS the human pastes into a root shell they enter
// FIRST. Rationale (decision 8): no on-disk script to leak the persona name and
// nothing to save; entering ONE root shell (`sudo -i`/`su -`) keeps the persona
// name out of the sudo/command AUDIT log (the become-root line carries no name,
// and commands typed in a root shell are not individually audited). The block is
// NEVER executed by anon-pi. This generator is PURE (account name, login user,
// and the anon-pi binary path are INJECTED), so the whole block is unit-testable
// as a STRING; nothing here spawns, sudo's, or touches the fs.
//
// The steps, and ONLY these (the block is small + auditable):
//   1. `sudo -i`                   become root FIRST (paste the rest in that shell).
//   2. `useradd -m <account>`      create the account WITH a home dir; this also
//                                  AUTO-ALLOCATES the subuid/subgid block
//                                  (decision 0: no explicit /etc/subuid+subgid
//                                  range line, so N personas never collide).
//   3. `loginctl enable-linger`    so `$XDG_RUNTIME_DIR` exists without a login.
//   4. the SCOPED sudoers snippet  `<login-user> ALL=(<account>) <anon-pi>`,
//      password KEPT (no NOPASSWD) by default: the password is what makes
//      crossing the DAC boundary a deliberate act (ADR-0006).
//
// It deliberately emits NO cross-user `chown`/workspace-migration line (v1 has
// no existing-workspace migration; that belongs to the deferred `harden` verb,
// idea `harden-command-with-import`) and NO `NETCAGE_GRAPHROOT` export (netcage's
// uid-scoped store, ADR-0017, handles itself when netcage runs as the account).

/** The injected inputs for the Tier-2 root-provisioning command generator. */
export interface Tier2ProvisioningInputs {
	/** The dedicated Unix account to create (canonically ANON_ACCOUNT = `anon`). */
	account: string;
	/**
	 * The LOGIN user granted the scoped sudoers rule (may run ONLY the anon-pi
	 * binary as `account`). Injected (the impure `whoami` lives in cli.ts).
	 */
	loginUser: string;
	/**
	 * The ABSOLUTE path to the anon-pi binary the sudoers rule scopes to (so the
	 * login user may run ONLY it as the account, nothing else). Injected.
	 */
	anonPiPath: string;
	/**
	 * Opt-in `--nopasswd`: emit a NOPASSWD sudoers rule (no password prompt when
	 * crossing). OFF by default (undefined / false) so the password is KEPT: the
	 * password is the deliberate-crossing feature (ADR-0006). Only for a
	 * single-user trusted box.
	 */
	nopasswd?: boolean;
}

/**
 * PURE: generate the Tier-2 root-requiring provisioning COMMAND BLOCK for a
 * hardened install. Returns COPY-PASTE COMMANDS the HUMAN pastes into a root
 * shell they enter FIRST; anon-pi PRINTS them and NEVER executes them (this
 * function only returns a string). It is NOT a `#!/bin/sh` script FILE (v1's
 * shape, retired per decision 8): there is nothing to save to disk and nothing
 * to leak the persona name, and the single become-root line keeps the persona
 * name out of the audit log. The block:
 *   - `sudo -i` becomes root FIRST (the rest is pasted in that root shell);
 *   - `useradd -m <account>` creates the account WITH a home dir AND lets
 *     shadow-utils AUTO-ALLOCATE its subuid/subgid block (decision 0: no
 *     explicit /etc/subuid+/etc/subgid range line, so N personas never collide);
 *   - `loginctl enable-linger <account>` gives the account a `$XDG_RUNTIME_DIR`
 *     without an interactive login (rootless podman needs it);
 *   - the sudoers snippet is `<loginUser> ALL=(<account>) <anon-pi>` (password
 *     KEPT unless `nopasswd`), validated with `visudo -cf` and `install`ed
 *     mode-0440 under /etc/sudoers.d/anon-pi-<account> (per-account, so
 *     provisioning a second persona never clobbers the first's rule file) so a
 *     syntax error never locks the operator out.
 * It emits NO cross-user `chown`/migration line and NO `NETCAGE_GRAPHROOT`
 * export (see the section header). Inputs are injected, so it is fully testable
 * as a string. The name `buildTier2ProvisioningScript` is kept for continuity
 * with the call sites; the returned STRING is a command block, not a file.
 */
export function buildTier2ProvisioningScript(
	inputs: Tier2ProvisioningInputs,
): string {
	const {account, loginUser, anonPiPath, nopasswd = false} = inputs;
	const sudoersRule = nopasswd
		? `${loginUser} ALL=(${account}) NOPASSWD: ${anonPiPath}`
		: `${loginUser} ALL=(${account}) ${anonPiPath}`;
	const sudoersFile = `/etc/sudoers.d/anon-pi-${account}`;
	return `# anon-pi Tier-2 provisioning (REVIEW, then run yourself). anon-pi
# GENERATED these commands and NEVER runs them: the root-requiring steps are
# explicit + auditable. Become root FIRST, then paste the rest into that shell
# (no script file is written; the become-root line keeps the account name out of
# the audit log).

# 0. Become root (or use \`su -\`), then paste the commands below in that shell.
sudo -i

# 1. Create the account WITH a home dir. This also auto-allocates its
#    subordinate uid/gid block (no explicit range line needed).
useradd -m ${account}

# 2. Enable linger so $XDG_RUNTIME_DIR exists without an interactive login.
loginctl enable-linger ${account}

# 3. Scoped sudoers rule: ${loginUser} may run ONLY anon-pi as ${account}.
#    Password ${nopasswd ? 'NOT required (--nopasswd opted in)' : 'KEPT (crossing the boundary is deliberate)'}.
#    Written to a temp file, validated with visudo -cf, then installed mode-0440,
#    so a syntax error can never lock you out.
tmp="$(mktemp)" && printf '%s\\n' '${sudoersRule}' >"$tmp" && visudo -cf "$tmp" && install -m 0440 -o root -g root "$tmp" '${sudoersFile}' && rm -f "$tmp"
`;
}

// --- The hardened-deployment PREFLIGHT (docs/adr/0006, prd story 6) -----------
//
// A half-provisioned `anon` account must fail LOUDLY with remediation, not
// cryptically. So before a hardened install runs anything as `anon`, anon-pi
// CHECKS the account is set up correctly and, when it is not, prints EXACTLY
// what is missing and how to fix it. This module owns only the PURE evaluation:
// each check is a predicate over an INJECTED probe result (a boolean the impure
// layer computes by reading `/etc/subuid`, `loginctl show-user`, `stat
// /dev/net/tun`, `$XDG_RUNTIME_DIR`, and `netcage --version`). The real probes
// live in cli.ts and are wired by the init-provisioning task; NOTHING here
// touches the fs or spawns. This mirrors the injected-`exists` seam the rest of
// this module uses (resolveModelsSeedPath etc.).
//
// The netcage dependency is the UID-SCOPED store (netcage ADR-0017): running
// netcage as `anon` auto-scopes its store to that uid, so anon-pi sets NO
// `NETCAGE_GRAPHROOT`. The preflight only ASSERTS netcage is new enough to have
// that store (>= NETCAGE_MIN_VERSION); it never weakens forced egress and never
// introduces a graphroot knob.

/**
 * The netcage version FLOOR the hardened deployment requires: `0.11.0`, the
 * release that shipped the UID-SCOPED store (netcage ADR-0017 / prd
 * `uid-scoped-graphroot-multi-user-fix`). Running netcage as `anon` needs this so
 * its store lands in the account's own uid-scoped path (`netcage-storage-<uid>`)
 * instead of colliding on the shared `/var/tmp/netcage-storage` of pre-0.11.0.
 * CONFIRMED (verified against the installed 0.10.0 vs 0.11.0 binaries). Kept as
 * the ONE named constant (a future bump is a single-line change), never a
 * scattered literal.
 */
export const NETCAGE_MIN_VERSION = '0.11.0';

/**
 * PURE: parse a netcage version STRING into a `[major, minor, patch]` numeric
 * triple, or undefined when it is UNPARSEABLE. Accepts the common shapes of
 * `netcage --version` output: a bare `1.2.3`, a `netcage 1.2.3`, a `v1.2.3`, or a
 * longer line whose FIRST dotted triple is the version (e.g. a build-info line).
 * The rule is deliberately narrow: the version is the first `<digits>.<digits>.
 * <digits>` run in the string; a pre-release/build suffix (`1.2.3-rc1`,
 * `1.2.3+meta`) keeps its numeric core. A string with no such triple (empty,
 * `unknown`, `netcage version ?`) is UNPARSEABLE => undefined, which the netcage
 * check treats as a fail-loud failure (never a silent pass).
 */
export function parseNetcageVersion(
	raw: string,
): [number, number, number] | undefined {
	const m = /(\d+)\.(\d+)\.(\d+)/.exec(raw);
	if (!m) return undefined;
	return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * PURE: compare two `[major, minor, patch]` triples lexicographically. Returns a
 * negative number when `a < b`, zero when equal, positive when `a > b` (the
 * usual comparator contract), so `compareVersionTriples(v, floor) >= 0` is
 * "v satisfies the floor".
 */
export function compareVersionTriples(
	a: readonly [number, number, number],
	b: readonly [number, number, number],
): number {
	for (let i = 0; i < 3; i++) {
		if (a[i] !== b[i]) return a[i] - b[i];
	}
	return 0;
}

/**
 * PURE: does a netcage version STRING satisfy the `>= floor` requirement?
 * Parses both sides (parseNetcageVersion) and compares the triples. An
 * UNPARSEABLE `raw` is NOT >= the floor (returns false); the netcage check maps
 * that, and an absent netcage, to a fail-loud failure with a distinct
 * remediation. `floor` defaults to NETCAGE_MIN_VERSION.
 */
export function netcageVersionSatisfies(
	raw: string,
	floor: string = NETCAGE_MIN_VERSION,
): boolean {
	const got = parseNetcageVersion(raw);
	if (!got) return false;
	const want = parseNetcageVersion(floor);
	// The floor is a code constant; if it ever fails to parse that is a bug, not
	// a runtime condition, so treat an unparseable floor as unsatisfiable.
	if (!want) return false;
	return compareVersionTriples(got, want) >= 0;
}

/**
 * The INJECTED probe results the pure preflight evaluates. Each field is what
 * the impure layer (cli.ts, wired by the init-provisioning task) computed by
 * touching the OS; the pure predicates only READ these. Keeping them injected is
 * what makes every check unit-testable with no real `netcage`/`loginctl`/`stat`
 * and no real system path.
 */
export interface HardenedPreflightProbes {
	/** True iff the `anon` account has BOTH an /etc/subuid and an /etc/subgid range. */
	subidRangesPresent: boolean;
	/** True iff linger is ON for `anon` (`loginctl enable-linger`, so $XDG_RUNTIME_DIR exists without a login). */
	lingerEnabled: boolean;
	/** True iff `/dev/net/tun` is present + accessible (netcage needs it). */
	tunAccessible: boolean;
	/** True iff the `anon` account's `$XDG_RUNTIME_DIR` is present (podman runroot lands there). */
	xdgRuntimeDirPresent: boolean;
	/**
	 * The `netcage --version` output STRING, or undefined when netcage is ABSENT
	 * (not on PATH / the probe could not run it). undefined = fail-loud "not
	 * found"; a present-but-unparseable string is fail-loud too (see the check).
	 */
	netcageVersion?: string;
}

/** The stable id of each preflight check (so a caller can key off a specific failure). */
export type HardenedPreflightCheckId =
	'subid' | 'linger' | 'tun' | 'xdg-runtime' | 'netcage-version';

/** One failing preflight check: its id + the EXACT remediation string to print. */
export interface HardenedPreflightFailure {
	id: HardenedPreflightCheckId;
	/** The verbatim, copy-pasteable remediation (what is missing + how to fix it). */
	remediation: string;
}

/**
 * The composed preflight RESULT: all-pass, or the ORDERED list of failures (each
 * with its exact remediation). `ok` is true iff `failures` is empty, so a caller
 * can branch on `ok` and, when false, print every `failures[i].remediation` in
 * order.
 */
export interface HardenedPreflightResult {
	ok: boolean;
	failures: HardenedPreflightFailure[];
}

/**
 * PURE: the EXACT remediation message for the subuid/subgid check. Names the
 * account and points at the Tier-2 provisioning commands anon-pi printed, which
 * create the account with `useradd -m <account>`: modern shadow-utils then
 * AUTO-ALLOCATES a free /etc/subuid + /etc/subgid block for it (no explicit
 * range line, per prd `multi-persona-hardened-accounts` decision 0), so the fix
 * is simply to run those commands.
 */
export function subidRemediation(account: string): string {
	return (
		`anon-pi: the \`${account}\` account has no /etc/subuid + /etc/subgid ranges ` +
		`(rootless podman needs them). Run the Tier-2 provisioning commands anon-pi ` +
		`printed (they \`useradd -m ${account}\`, which auto-allocates the ranges), ` +
		`then re-run.`
	);
}

/**
 * PURE: the EXACT remediation message for the linger check. linger is what gives
 * the account a `$XDG_RUNTIME_DIR` with no active login session (rootless podman
 * needs it), so the fix is `loginctl enable-linger <account>`.
 */
export function lingerRemediation(account: string): string {
	return (
		`anon-pi: linger is not enabled for the \`${account}\` account, so its ` +
		`\$XDG_RUNTIME_DIR does not exist without a login session (rootless podman ` +
		`needs it). Enable it: \`sudo loginctl enable-linger ${account}\`, then re-run.`
	);
}

/**
 * PURE: the EXACT remediation message for the `/dev/net/tun` check. netcage's
 * jail needs the tun device; if it is missing the kernel `tun` module is not
 * loaded (or the device node is absent).
 */
export function tunRemediation(): string {
	return (
		'anon-pi: /dev/net/tun is not accessible (netcage needs it for the jail). ' +
		'Load the tun module (`sudo modprobe tun`) and ensure /dev/net/tun exists, ' +
		'then re-run.'
	);
}

/**
 * PURE: the EXACT remediation message for the account `$XDG_RUNTIME_DIR` check.
 * The runtime dir is where podman's rootless runroot lands; it appears once
 * linger is on and the account has a session, so the fix routes back through
 * linger.
 */
export function xdgRuntimeRemediation(account: string): string {
	return (
		`anon-pi: the \`${account}\` account has no \$XDG_RUNTIME_DIR (podman's ` +
		`rootless runroot lands there). It appears once linger is enabled: run ` +
		`\`sudo loginctl enable-linger ${account}\`, then re-run.`
	);
}

/**
 * PURE: the EXACT remediation message for the netcage-version check. Distinct
 * text for ABSENT vs TOO-OLD/UNPARSEABLE, because they are fixed differently
 * (install netcage vs upgrade it), but BOTH are fail-loud (never a silent pass).
 * `found` is the version string the probe saw (undefined = netcage absent).
 */
export function netcageVersionRemediation(found: string | undefined): string {
	if (found === undefined) {
		return (
			`anon-pi: netcage was not found. The hardened deployment needs netcage ` +
			`>= ${NETCAGE_MIN_VERSION} (its uid-scoped store, so running as \`${ANON_ACCOUNT}\` ` +
			`does not collide with your login user's store). Install netcage ` +
			`>= ${NETCAGE_MIN_VERSION}, then re-run.`
		);
	}
	const parsed = parseNetcageVersion(found);
	const gotDesc = parsed
		? `found ${parsed.join('.')}`
		: `could not parse the version from ${JSON.stringify(found)}`;
	return (
		`anon-pi: netcage is too old (${gotDesc}); the hardened deployment needs ` +
		`>= ${NETCAGE_MIN_VERSION} for its uid-scoped store (so running as ` +
		`\`${ANON_ACCOUNT}\` does not collide with your login user's store). Upgrade ` +
		`netcage to >= ${NETCAGE_MIN_VERSION}, then re-run.`
	);
}

/**
 * PURE: evaluate the hardened-deployment preflight over INJECTED probe results.
 * Runs every check in a FIXED order (subuid/subgid, linger, /dev/net/tun,
 * account $XDG_RUNTIME_DIR, netcage version) and returns an all-pass result or
 * the ORDERED list of failures, each carrying its EXACT remediation string. The
 * netcage check FAILS on `< NETCAGE_MIN_VERSION`, on an ABSENT netcage
 * (undefined), and on an UNPARSEABLE version string (fail-loud, never a silent
 * pass). Nothing here touches the fs or spawns: it only reads `probes`.
 * `account` defaults to ANON_ACCOUNT (canonically `anon`).
 */
export function evaluateHardenedPreflight(
	probes: HardenedPreflightProbes,
	account: string = ANON_ACCOUNT,
): HardenedPreflightResult {
	const failures: HardenedPreflightFailure[] = [];
	if (!probes.subidRangesPresent) {
		failures.push({id: 'subid', remediation: subidRemediation(account)});
	}
	if (!probes.lingerEnabled) {
		failures.push({id: 'linger', remediation: lingerRemediation(account)});
	}
	if (!probes.tunAccessible) {
		failures.push({id: 'tun', remediation: tunRemediation()});
	}
	if (!probes.xdgRuntimeDirPresent) {
		failures.push({
			id: 'xdg-runtime',
			remediation: xdgRuntimeRemediation(account),
		});
	}
	if (
		probes.netcageVersion === undefined ||
		!netcageVersionSatisfies(probes.netcageVersion)
	) {
		failures.push({
			id: 'netcage-version',
			remediation: netcageVersionRemediation(probes.netcageVersion),
		});
	}
	return {ok: failures.length === 0, failures};
}

// --- The resumable hardening-step ORCHESTRATOR (docs/adr/0006, prd stories 1,5-8)
//
// The PURE decision that stitches the three pieces above (preflight, Tier-2
// script, Tier-1 plan) into the resumable `init` hardening step. Given the
// injected preflight RESULT (over real probes computed by cli.ts) plus the
// account/login-user/binary inputs, it decides the ONE next action of the step:
//
//   - preflight FAILS  => the `anon` account is missing/half-provisioned. Emit
//     the Tier-2 provisioning COMMANDS (buildTier2ProvisioningScript) plus a
//     "become root and paste them, then continue" instruction, and
//     signal WAIT. The impure loop prints these, waits, RE-PROBES, and calls
//     this again (resumability: the state lives in the OS, not a flag — a
//     re-run just re-evaluates the fresh preflight).
//   - preflight PASSES => proceed with Tier 1: point `ANON_PI_HOME` into the
//     `anon` account's tree (mode-700) and finish. NO wrapper file is produced
//     (self-re-exec replaces it) and `NETCAGE_GRAPHROOT` is NEVER set.
//
// It is a pure function over the injected preflight result + paths: cli.ts does
// the real probing, printing, waiting, and the mode-700 workspace write. This
// keeps the resumable decision unit-testable at a single seam (missing-account
// -> print-and-wait; passing -> continue) with no sudo/podman/netcage/loginctl.

/** The injected inputs the hardening-step orchestrator decides over. */
export interface HardeningStepInputs {
	/** The preflight RESULT cli.ts computed over the real probes (evaluateHardenedPreflight). */
	preflight: HardenedPreflightResult;
	/** The dedicated account to provision/run under (canonically ANON_ACCOUNT = `anon`). */
	account: string;
	/** The login user the Tier-2 sudoers rule is scoped to (from the impure `whoami`). */
	loginUser: string;
	/** The ABSOLUTE anon-pi binary path the Tier-2 sudoers rule scopes to (injected). */
	anonPiPath: string;
	/**
	 * The ABSOLUTE ANON_PI_HOME under the `anon` account's tree (mode-700 on
	 * continue). cli.ts resolves it (e.g. `~anon/.anon-pi`) from the real account
	 * home; injected so the plan stays pure.
	 */
	anonHome: string;
	/**
	 * Opt-in `--nopasswd` forwarded to the Tier-2 generator (OFF by default: the
	 * kept sudo password is the deliberate-crossing feature, ADR-0006).
	 */
	nopasswd?: boolean;
}

/**
 * `wait-for-account`: the `anon` account is missing/half-provisioned. cli.ts
 * PRINTS `script` (the reviewable Tier-2 root COMMAND BLOCK) + `instruction`,
 * then waits for the human to run it and continue; on continue it RE-PROBES and
 * re-plans. `failures` echoes the exact preflight remediations so the caller can
 * show precisely what is missing.
 */
export interface HardeningWaitPlan {
	kind: 'wait-for-account';
	/** The Tier-2 provisioning COMMAND BLOCK to print (never executed by anon-pi). */
	script: string;
	/** The "become root, paste the commands, then continue" instruction printed alongside the block. */
	instruction: string;
	/** The ordered preflight failures (each with its exact remediation) driving the wait. */
	failures: HardenedPreflightFailure[];
}

/**
 * `continue-tier1`: the preflight passed, so proceed with the rootless Tier-1
 * setup: point `ANON_PI_HOME` at `anonHome` (under the account's tree) and apply
 * mode `0o700`. NO wrapper file is produced (self-re-exec replaces it) and
 * `NETCAGE_GRAPHROOT` is never set. cli.ts performs the real mkdir + chmod.
 */
export interface HardeningContinuePlan {
	kind: 'continue-tier1';
	/** The ABSOLUTE ANON_PI_HOME under the `anon` account's tree to create + own. */
	anonHome: string;
	/** The mode Tier 1 applies to `anonHome` (mode-700: only the account may read it). */
	mode: number;
}

/** The next action of the resumable hardening step: wait for the account, or continue Tier 1. */
export type HardeningStepPlan = HardeningWaitPlan | HardeningContinuePlan;

/** The mode Tier 1 applies to the `anon` workspace: 0o700 (only the account reads it). */
export const HARDENED_HOME_MODE = 0o700;

/**
 * PURE: decide the next action of the resumable `init` hardening step over the
 * INJECTED preflight result. When the preflight FAILS (the `anon` account is
 * missing or half-provisioned) it returns a `wait-for-account` plan carrying the
 * Tier-2 command block to print + a run-it-then-continue instruction + the exact
 * failures; the impure loop prints, waits, RE-PROBES, and calls this again (the
 * resumable state is the OS itself, so a re-run just re-evaluates a fresh
 * preflight — idempotent, no continue-flag to persist). When the preflight
 * PASSES it returns a `continue-tier1` plan (point `ANON_PI_HOME` into the
 * account's tree at mode 0o700, no wrapper file, no `NETCAGE_GRAPHROOT`).
 * Nothing here spawns, probes, or touches the fs.
 */
export function planHardeningStep(
	inputs: HardeningStepInputs,
): HardeningStepPlan {
	const {preflight, account, loginUser, anonPiPath, anonHome, nopasswd} =
		inputs;
	if (preflight.ok) {
		return {kind: 'continue-tier1', anonHome, mode: HARDENED_HOME_MODE};
	}
	const script = buildTier2ProvisioningScript({
		account,
		loginUser,
		anonPiPath,
		nopasswd,
	});
	const instruction =
		`anon-pi: the \`${account}\` account is not fully provisioned yet. The ` +
		`root-requiring steps are the COMMANDS ABOVE: review them, then become root ` +
		`in ANOTHER terminal (\`sudo -i\` or \`su -\`; anon-pi never sudo's for you) ` +
		`and paste them into that root shell. When they finish, come back here and ` +
		`continue: anon-pi RE-CHECKS the account (the preflight) and proceeds once ` +
		`it exists.`;
	return {
		kind: 'wait-for-account',
		script,
		instruction,
		failures: preflight.failures,
	};
}

// --- `anon-pi persona add <name>`: the pure provisioning planner + parser (prd
// `multi-persona-hardened-accounts`, decisions 4 + 5 + 6 + 7 + 8, superseding
// ADR-0006) -------------------------------------------------------------------
//
// `persona add <name>` provisions a persona: the dedicated `anon-<name>` account
// (default `anon`), its mode-700 workspace + its own fail-closed egress. Like
// v1's init hardening it is a TWO-TIER flow, now per-persona:
//   - Tier 2 (root): create the account (`useradd -m`, linger, scoped sudoers).
//     anon-pi NEVER runs this: it PRINTS the copy-paste command block
//     (buildTier2ProvisioningScript) the human pastes into a root shell entered
//     FIRST. Because the Tier-1 in-home write needs the account to already
//     exist, the flow is RESUMABLE (mirroring planHardeningStep): while the
//     account is missing, emit Tier-2 + wait; once it exists, do Tier 1.
//   - Tier 1 (rootless): write the persona's OWN ordinary v1 `config.json`
//     (byte-identical shape, just resolved in the persona's home) carrying the
//     chosen `proxy`, into `~anon-<name>/.anon-pi` at mode 0o700.
// Egress is chosen at add time (Tor multi-persona via composeTorPersonaProxy, or
// a bring-your-own socks5h endpoint with the uniqueness WARNING); the CLI does
// the Tor probe + the prompts. This section owns only the PURE parts: the
// `persona <verb>` grammar, the BYO warning wording, and the resumable
// provisioning PLANNER over injected inputs (account existence + the composed
// config). Nothing here spawns, probes Tor, or touches the fs; the CLI wires the
// getent/probe/write around it. Persona IDENTITY (email/git) is OUT of scope.

/**
 * The EXACT one-line uniqueness WARNING printed on the bring-your-own SOCKS path
 * of `persona add` (prd `multi-persona-hardened-accounts` decision 6). A BYO
 * endpoint must be UNIQUE to a persona: two personas sharing one BYO endpoint
 * share an exit IP and become linkable, defeating the isolation that matters
 * most. anon-pi keeps NO used-endpoint list (it cannot read across personas' DAC
 * walls), so it WARNS and leaves uniqueness to the operator, steering them to Tor
 * (which isolates per-persona automatically by the SOCKS-isolation username).
 * Pinned as one constant so the CLI and its test agree and it never drifts.
 */
export const PERSONA_BYO_UNIQUENESS_WARNING =
	'anon-pi: this socks5h endpoint MUST be unique to this persona. Two personas ' +
	'on one bring-your-own endpoint share an exit IP and become linkable, ' +
	'defeating per-persona isolation. anon-pi keeps NO used-endpoint list, so ' +
	'this is your responsibility. Prefer Tor multi-persona, which isolates each ' +
	'persona automatically by its account name.';

/**
 * A parsed `persona <verb> …` command. A discriminated union the CLI dispatches
 * on `verb`. v1 ships ONLY `add`:
 *   - `add [<name>]`: provision the persona `anon-<name>`; a bare `add` (no
 *     name) provisions/refers to the DEFAULT persona `anon` (the empty-suffix
 *     case). The bare name is validated by personaAccount (validatePersonaName)
 *     in the CLI, not here, so the parser stays a thin grammar; `name` is the
 *     raw token (undefined for the default).
 */
export type PersonaCommand = {verb: 'add'; name?: string};

/**
 * PURE: parse the tokens AFTER `persona` into a PersonaCommand. Throws
 * AnonPiError (printed verbatim, exit 1) for a missing/unknown subcommand. The
 * grammar is deliberately tiny (only `add [<name>]` in v1) and the optional bare
 * NAME, when present, comes FIRST (`persona add <name> [flags…]`): so the name
 * is `rest[0]` iff it is a non-flag token. Everything AFTER the name is FLAGS
 * (`--tor`/`--proxy`/`--nopasswd`, impure-flow knobs the CLI parses, since flag
 * ARITY lives there), so this pure grammar does not try to interpret them (a
 * flag with a value like `--proxy <url>` would otherwise look like a positional).
 * The name is NOT charset-validated here (that is personaAccount's job in the
 * CLI); this only splits off the verb + optional leading bare name.
 */
export function parsePersonaArgs(args: readonly string[]): PersonaCommand {
	const fail = (msg: string): never => {
		throw new AnonPiError(
			`anon-pi: ${msg}\nRun \`anon-pi persona --help\` or \`anon-pi --help\`.`,
		);
	};

	const verb = args[0];
	if (verb === undefined) {
		fail('`persona` needs a subcommand: add');
	}
	if (verb !== 'add') {
		fail(
			`unknown \`persona\` subcommand ${JSON.stringify(verb)} (only \`add\`).`,
		);
	}

	const rest = args.slice(1);
	// The name is the FIRST token iff it is not a flag; everything after is flags.
	const name =
		rest[0] !== undefined && !rest[0].startsWith('-') ? rest[0] : undefined;
	return {verb: 'add', name};
}

/** The injected inputs the resumable `persona add` provisioning planner decides over. */
export interface PersonaAddInputs {
	/** The persona Unix account being provisioned (`anon-<name>`, or `anon` for the default). */
	account: string;
	/** The login user the Tier-2 sudoers rule is scoped to (from the impure `whoami`). */
	loginUser: string;
	/** The ABSOLUTE anon-pi binary path the Tier-2 sudoers rule scopes to (injected). */
	anonPiPath: string;
	/**
	 * Whether the persona's Unix account ALREADY EXISTS (from the impure `getent
	 * passwd <account>` probe). This is the resumable GATE: while it is false the
	 * account's home does not exist to write into, so the planner emits Tier 2 and
	 * WAITS; once true (re-probed after the human ran the root commands) it
	 * proceeds to the Tier-1 in-home write.
	 */
	accountExists: boolean;
	/**
	 * The ABSOLUTE ANON_PI_HOME under the persona account's tree
	 * (`~anon-<name>/.anon-pi`), resolved by the CLI from the real account home
	 * (getent) once the account exists. Undefined while the account is missing.
	 */
	anonHome?: string;
	/**
	 * The persona's ORDINARY v1 config.json to write in Tier 1 (byte-identical
	 * shape, just resolved in the persona's home), carrying the composed/entered
	 * per-persona `proxy`. The planner echoes it back on continue; the CLI writes
	 * it (serializeConfigJson) at mode 0o700.
	 */
	config?: AnonPiConfig;
	/**
	 * Whether the persona is ALREADY fully provisioned (the account exists AND its
	 * config.json already carries a proxy). When true the planner returns
	 * `already-provisioned` so a re-run is an idempotent no-op, never a duplicate
	 * or a failure (decision: re-adding an existing persona re-checks).
	 */
	alreadyProvisioned?: boolean;
	/**
	 * Opt-in `--nopasswd` forwarded to the Tier-2 generator (OFF by default: the
	 * kept sudo password is the deliberate-crossing feature, ADR-0006).
	 */
	nopasswd?: boolean;
}

/**
 * `wait-for-account`: the persona's account does not exist yet. The CLI PRINTS
 * `script` (the Tier-2 copy-paste COMMAND BLOCK, never executed by anon-pi) +
 * `instruction`, waits for the human to run it in a root shell they entered
 * first, then RE-PROBES the account and re-plans (resumability: the state is the
 * OS itself, so a re-run just re-evaluates a fresh `getent`).
 */
export interface PersonaWaitPlan {
	kind: 'wait-for-account';
	/** The Tier-2 provisioning COMMAND BLOCK to print (never executed by anon-pi). */
	script: string;
	/** The "become root, paste the commands, then continue" instruction printed alongside the block. */
	instruction: string;
}

/**
 * `continue-tier1`: the account exists, so do the rootless Tier-1 in-home write:
 * create the persona's `anonHome` (mode 0o700) and write its ordinary v1
 * `config.json` (carrying the persona `proxy`) there. NO wrapper file, NO
 * `NETCAGE_GRAPHROOT`. The CLI performs the real mkdir + chmod + write.
 */
export interface PersonaContinuePlan {
	kind: 'continue-tier1';
	/** The ABSOLUTE ANON_PI_HOME under the persona account's tree to create + own. */
	anonHome: string;
	/** The mode Tier 1 applies to `anonHome` (mode-700: only the persona reads it). */
	mode: number;
	/** The persona's ordinary v1 config.json to write (carrying its `proxy`). */
	config: AnonPiConfig;
}

/**
 * `already-provisioned`: the persona already exists AND its config.json already
 * carries a proxy, so `persona add` is an idempotent no-op (re-check, not a
 * failure or a duplicate).
 */
export interface PersonaDonePlan {
	kind: 'already-provisioned';
}

/** The next action of the resumable `persona add` step. */
export type PersonaAddPlan =
	PersonaWaitPlan | PersonaContinuePlan | PersonaDonePlan;

/** The mode Tier 1 applies to a persona's workspace: 0o700 (only the persona reads it). */
export const PERSONA_HOME_MODE = HARDENED_HOME_MODE;

/**
 * PURE: decide the next action of the resumable `persona add` step over INJECTED
 * inputs. Mirrors planHardeningStep, but the resumable GATE is simply "does the
 * persona's account exist yet?" (its home must exist to write the Tier-1 config
 * into). The order is:
 *   - `alreadyProvisioned` (account exists AND its config already has a proxy)
 *     -> `already-provisioned`: an idempotent no-op re-run (decision: re-adding
 *     an existing persona re-checks, never duplicates or fails).
 *   - account MISSING -> `wait-for-account`: emit the Tier-2 command block
 *     (buildTier2ProvisioningScript) + a become-root-and-continue instruction;
 *     the CLI prints, waits, RE-PROBES, and calls this again.
 *   - account EXISTS -> `continue-tier1`: create `anonHome` mode-0o700 and write
 *     the persona's ordinary v1 config.json (with its `proxy`) there.
 * Nothing here spawns, probes, or touches the fs; the CLI wires the real
 * getent/Tor-probe/write around it. `anonHome` + `config` are REQUIRED on the
 * continue branch (the CLI resolves them once the account exists); a missing one
 * there is a programming error (throws AnonPiError).
 */
export function planPersonaAdd(inputs: PersonaAddInputs): PersonaAddPlan {
	const {
		account,
		loginUser,
		anonPiPath,
		accountExists,
		anonHome,
		config,
		alreadyProvisioned,
		nopasswd,
	} = inputs;

	if (alreadyProvisioned) return {kind: 'already-provisioned'};

	if (!accountExists) {
		const script = buildTier2ProvisioningScript({
			account,
			loginUser,
			anonPiPath,
			nopasswd,
		});
		const instruction =
			`anon-pi: the persona account \`${account}\` does not exist yet. The ` +
			`root-requiring steps are the COMMANDS ABOVE: review them, then become root ` +
			`in ANOTHER terminal (\`sudo -i\` or \`su -\`; anon-pi never sudo's for you) ` +
			`and paste them into that root shell. When they finish, come back here and ` +
			`continue: anon-pi RE-CHECKS the account and writes the persona's config ` +
			`once it exists.`;
		return {kind: 'wait-for-account', script, instruction};
	}

	if (anonHome === undefined || config === undefined) {
		throw new AnonPiError(
			'anon-pi: internal error: persona Tier-1 continue needs a resolved home ' +
				'and config (the account exists but one was not provided).',
		);
	}
	return {kind: 'continue-tier1', anonHome, mode: PERSONA_HOME_MODE, config};
}

/** The --help text (kept here so it is covered by the same module). */
export const HELP = `anon-pi - run pi on anonymized, jailed machines (netcage: forced egress + one direct local model)

USAGE
  anon-pi                        MENU: pick a project (pi), a shell, or a new project
  anon-pi <project>              pi in the project (${CONTAINER_PROJECTS_ROOT}/<project>); exit pi -> host
  anon-pi <project> <pi-args…>   forward args to pi (e.g. -p for a headless one-shot)
  anon-pi <project> -p --mode text-stream <q>  headless one-shot that STREAMS the
                                 agent's progress live (assistant text + tool calls
                                 to stderr; the final answer to stdout, so it pipes).
                                 anon-pi-owned mode: needs -p; not with another --mode.
  anon-pi <pi-args…>             any leading pi flag with no project forwards to pi
                                 (e.g. \`anon-pi -p "hello world"\`, \`anon-pi --model x\`)
  anon-pi --session <id>         resume a pi session by id, in its own project (also -r/--resume)
  anon-pi <project> --fork <id>  fork a session into <project> (\`.\`=root; --continue too; project required)
  anon-pi --list-models          list the models pi sees (also --models; no project needed)
  anon-pi pi <pi-args…>          explicit passthrough: run pi with ANY args and no project
  anon-pi --version              print anon-pi's version (also -V)
  anon-pi --shell [<project>]    a jailed bash (at /projects, or cd'd into <project>) - the project-hopper
  anon-pi forward [<p>] [--port …]  open a host port onto a running container's in-jail server
  anon-pi ports [<project>]      list a running container's open in-jail TCP listeners
  anon-pi -m <machine> [<p>]     the same, on <machine> (its own image + home + conversations)
  anon-pi -i <ref> [<p>]         run against <ref> for THIS launch only (also --image; ephemeral)
  anon-pi --mount <parent> [<p>] root at a HOST parent folder instead of the projects root
  anon-pi init                   onboard: verify your proxy, capture your local model, pick an image
  anon-pi machine …              manage machines (create / list / set-image / rm)
  anon-pi image …                snapshot a running container into an image; list anon-pi images
  anon-pi container …            durable named boxes: create / enter / list / rm (survive exit)
  anon-pi --delete-home [<m>]    delete a machine's home (config + convos); keep its image pin + files
  anon-pi --delete-project <p>   delete a project's files + its per-machine sessions; keep the homes

  <project>   a folder under the projects root (mounted at ${CONTAINER_PROJECTS_ROOT}; pi's cwd). \`.\` means
              the root itself (a scratch pi at ${CONTAINER_PROJECTS_ROOT}, ${CONTAINER_MOUNT_ROOT} for --mount, or ~).

  -i <ref>, --image <ref>   EPHEMERAL per-launch image override, highest priority
              (\`-i\` > the machine's machine.json image > ANON_PI_IMAGE). It picks the
              IMAGE for this launch only; \`-m\` picks the HOME, and the two compose.
              It NEVER changes machine.json (to re-pin a machine's image, use
              \`anon-pi machine set-image\` / \`machine create --image\`). No mismatch
              warning is printed. <ref> resolves in NETCAGE'S private image store
              (\`anon-pi/<name>:latest\` snapshots + \`init\`-built images live there),
              NOT your default podman store; anon-pi does NOT pre-check it and does
              NOT auto-pull (an anonymity tool must not silently fetch a remote
              image). A "not found" means the ref is not in netcage's store: snapshot
              it (\`anon-pi image snapshot <name>\`) or build it into that store.
              On a FRESH machine home \`-i\` is REFUSED (it would seed the home from
              the wrong image); establish the machine's image with
              \`anon-pi machine create <m> --image <ref>\` first.

  A bare launch is THROWAWAY: the container is removed on exit. To persist system
  state you built in a session, snapshot the running container into a named image
  (\`anon-pi image snapshot <name>\`) and pin a machine to it (\`anon-pi machine
  create <m> --image anon-pi/<name>:latest\`); OR, for a single mutable box that
  ACCRETES scratch across sessions, \`anon-pi container create <name>\` a durable
  box and re-enter it with \`anon-pi container enter <name>\`. Your pi config +
  conversations live in the machine home (a host mount) and persist regardless.

WHAT IT DOES
  Runs pi inside netcage with all web/DNS egress forced through the socks5h proxy
  (fail-closed) and ONE direct hole to your local model (ANON_PI_LLM). A MACHINE
  is an image + a persistent HOST home (bind-mounted at ${CONTAINER_HOME_ROOT}) holding your pi
  config, extensions, and conversations; the container is disposable (throwaway),
  so it loses nothing. Files (projects) are global by default; conversations are
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
