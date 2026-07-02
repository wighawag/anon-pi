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

import {createHash} from 'node:crypto';
import {homedir} from 'node:os';
import {isAbsolute, join, resolve} from 'node:path';

/** The container path the workdir is mounted at (pi's cwd). */
export const CONTAINER_WORKDIR = '/work';

/**
 * The DEFAULT container path the seeded pi config is mounted at (the pi global).
 * Absolute and image-independent: both podman (the -v target) and pi (the
 * PI_CODING_AGENT_DIR env) agree on it with no home-resolution guessing. A user
 * who knows their image's home can override it (ANON_PI_AGENT_MOUNT) to the
 * standard `~/.pi/agent` location, e.g. /root/.pi/agent for a root image.
 */
export const DEFAULT_CONTAINER_AGENT_DIR = '/opt/pi-agent';

/** The pi env var that overrides its config dir (see pi config.ts getAgentDir). */
export const PI_AGENT_DIR_ENV = 'PI_CODING_AGENT_DIR';

/** Inputs resolved from the environment + argv, injected so this stays pure. */
export interface AnonPiEnv {
	/** $HOME (or an override) used to derive default paths. */
	home: string;
	/** socks5h proxy URL. Default socks5h://127.0.0.1:9050. */
	proxy?: string;
	/** The anon-pi home dir. Default $XDG_CONFIG_HOME/anon-pi or ~/.config/anon-pi. */
	anonPiHome?: string;
	/** Override the canonical seed dir. Default <anonPiHome>/agent. */
	configSeed?: string;
	/** The container image that has `pi` on PATH. REQUIRED. */
	image?: string;
	/** The RFC1918/link-local IP[:port] of the local model. REQUIRED. */
	llmDirect?: string;
	/** XDG_CONFIG_HOME, if set (used to derive the default anon-pi home). */
	xdgConfigHome?: string;
	/**
	 * The ABSOLUTE container path to mount the seeded config at (and point pi's
	 * PI_CODING_AGENT_DIR at). Default /opt/pi-agent. Set it to your image's real
	 * `~/.pi/agent` (e.g. /root/.pi/agent) if you want the standard location.
	 * MUST be absolute: podman does not expand `~`, so a `~`-relative value would
	 * be mounted literally. Rejected if it starts with `~` or is not absolute.
	 */
	agentMount?: string;
}

/** The fully-resolved run plan cli.ts executes. */
export interface RunPlan {
	/** Absolute workdir on the host (mounted at /work). */
	workdir: string;
	/** The per-session seeded config dir on the host (mounted as the pi global). */
	sessionAgentDir: string;
	/** The canonical seed dir to copy FROM (read-only by convention). */
	configSeed: string;
	/** The absolute container path the session config is mounted at (== pi's config dir). */
	agentMount: string;
	/** True iff the session dir does not exist yet and must be seeded from configSeed. */
	needsSeed: boolean;
	/** The argv passed to `netcage` (after the `netcage` program name). */
	netcageArgs: string[];
}

const DEFAULT_PROXY = 'socks5h://127.0.0.1:9050';

/** A user-facing error whose message is meant to be printed verbatim (no stack). */
export class AnonPiError extends Error {}

/**
 * Resolve the container agent-mount path: ANON_PI_AGENT_MOUNT or the default.
 * It MUST be an absolute container path, because it is BOTH the podman `-v`
 * target AND pi's PI_CODING_AGENT_DIR, and podman (unlike pi) does not expand
 * `~`. A `~`-relative or relative value is rejected loudly rather than silently
 * mounted at a literal `~` directory or a cwd-relative path.
 */
export function resolveAgentMount(env: AnonPiEnv): string {
	const raw =
		env.agentMount && env.agentMount.trim() !== ''
			? env.agentMount.trim()
			: DEFAULT_CONTAINER_AGENT_DIR;
	if (raw.startsWith('~')) {
		throw new AnonPiError(
			`anon-pi: ANON_PI_AGENT_MOUNT must be an ABSOLUTE container path, not \`${raw}\`. ` +
				'podman does not expand `~`; use the concrete home, e.g. /root/.pi/agent.',
		);
	}
	if (!raw.startsWith('/')) {
		throw new AnonPiError(
			`anon-pi: ANON_PI_AGENT_MOUNT must be an ABSOLUTE container path, not \`${raw}\` (it is both the mount target and pi's config dir).`,
		);
	}
	return raw;
}

/** Resolve the anon-pi home dir (holds the canonical seed + per-session state). */
export function resolveAnonPiHome(env: AnonPiEnv): string {
	if (env.anonPiHome) return resolve(env.anonPiHome);
	const base =
		env.xdgConfigHome && env.xdgConfigHome.trim() !== ''
			? env.xdgConfigHome
			: join(env.home, '.config');
	return join(base, 'anon-pi');
}

/** The canonical seed dir (copied FROM, never mounted). */
export function resolveConfigSeed(env: AnonPiEnv): string {
	if (env.configSeed) return resolve(env.configSeed);
	return join(resolveAnonPiHome(env), 'agent');
}

/**
 * Session id = a stable short hash of the ABSOLUTE workdir path, so re-running
 * anon-pi on the same folder resumes the same session config+state, and moving
 * the folder starts a new session (documented, accepted).
 */
export function sessionId(absWorkdir: string): string {
	return createHash('sha256').update(absWorkdir).digest('hex').slice(0, 16);
}

/** The per-session seeded config dir on the host for a given workdir. */
export function sessionAgentDir(env: AnonPiEnv, absWorkdir: string): string {
	return join(
		resolveAnonPiHome(env),
		'sessions',
		sessionId(absWorkdir),
		'agent',
	);
}

/**
 * Build the run plan from the environment + the (optional) workdir arg. PURE: it
 * resolves paths and composes the netcage argv, and reports whether a seed copy
 * is needed, but performs NO filesystem writes or spawns. It THROWS AnonPiError
 * for the two hard preconditions (missing image, missing llm) so the required
 * inputs fail loud; the missing-SEED check is left to cli.ts (it needs a real
 * `existsSync`), but `needsSeed` is derived from the injected `seedExists`.
 */
export function buildRunPlan(
	env: AnonPiEnv,
	workdirArg: string | undefined,
	seedExists: (dir: string) => boolean,
	sessionExists: (dir: string) => boolean,
): RunPlan {
	if (!env.image || env.image.trim() === '') {
		throw new AnonPiError(
			'anon-pi: set ANON_PI_IMAGE to a container image that has `pi` on its PATH.\n' +
				'\n' +
				'No such image yet? Build a small one from the upstream-documented recipe\n' +
				'(it installs the official @earendil-works/pi-coding-agent npm package):\n' +
				'\n' +
				"  cat > Dockerfile.pi <<'EOF'\n" +
				'  FROM node:24-bookworm-slim\n' +
				'  RUN apt-get update && apt-get install -y --no-install-recommends \\\n' +
				'        bash ca-certificates git ripgrep && rm -rf /var/lib/apt/lists/*\n' +
				'  RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent\n' +
				'  WORKDIR /work\n' +
				'  EOF\n' +
				'  podman build -t localhost/anon-pi-pi:latest -f Dockerfile.pi .\n' +
				'  export ANON_PI_IMAGE=localhost/anon-pi-pi:latest\n' +
				'\n' +
				'A ready Dockerfile.pi also ships with this package. See the README\n' +
				'(Providing a pi image) for details and a community-image note.',
		);
	}
	if (!env.llmDirect || env.llmDirect.trim() === '') {
		throw new AnonPiError(
			'anon-pi: set ANON_PI_LLM to the RFC1918/link-local IP[:port] of the local model pi should reach directly (e.g. ANON_PI_LLM=192.168.1.150:8080). All other egress stays forced through the proxy.',
		);
	}

	const home = env.home;
	if (!home || home.trim() === '') {
		throw new AnonPiError('anon-pi: could not resolve HOME.');
	}

	const raw =
		workdirArg && workdirArg.trim() !== '' ? workdirArg : process.cwd();
	const workdir = isAbsolute(raw) ? raw : resolve(raw);

	const configSeed = resolveConfigSeed(env);
	if (!seedExists(configSeed)) {
		throw new AnonPiError(
			`anon-pi: canonical config not found at ${configSeed}.\n` +
				'anon-pi never populates it for you. Create it yourself with the pi config you want\n' +
				'(anon accounts, chosen models/skills, and a trust.json that trusts /work), e.g.:\n' +
				`  mkdir -p ${configSeed}\n` +
				`  cp -a ~/.pi/agent/. ${configSeed}/    # then remove any identity you do not want anonymized\n` +
				'See the README (Populating the seed) for the trust.json requirement.',
		);
	}

	const sessionDir = sessionAgentDir(env, workdir);
	const needsSeed = !sessionExists(sessionDir);

	const agentMount = resolveAgentMount(env);
	const proxy =
		env.proxy && env.proxy.trim() !== '' ? env.proxy : DEFAULT_PROXY;

	const netcageArgs = [
		'run',
		'--proxy',
		proxy,
		'--allow-direct',
		env.llmDirect,
		'-it',
		'-v',
		workdir, // netcage defaults a target-less -v to /work and cwd to /work
		'-v',
		`${sessionDir}:${agentMount}`,
		'-e',
		`${PI_AGENT_DIR_ENV}=${agentMount}`,
		env.image,
		'pi',
	];

	return {
		workdir,
		sessionAgentDir: sessionDir,
		configSeed,
		agentMount,
		needsSeed,
		netcageArgs,
	};
}

/** Read the AnonPiEnv from a process env map (kept separate so tests inject one). */
export function envFromProcess(
	penv: Record<string, string | undefined>,
): AnonPiEnv {
	return {
		home: penv.HOME ?? homedir(),
		proxy: penv.ANON_PI_PROXY,
		anonPiHome: penv.ANON_PI_HOME,
		configSeed: penv.ANON_PI_CONFIG,
		image: penv.ANON_PI_IMAGE,
		llmDirect: penv.ANON_PI_LLM,
		xdgConfigHome: penv.XDG_CONFIG_HOME,
		agentMount: penv.ANON_PI_AGENT_MOUNT,
	};
}

/** The --help text (kept here so it is covered by the same module). */
export const HELP = `anon-pi - launch pi inside a netcage (anonymized egress + one direct local model)

USAGE
  anon-pi [WORKDIR]

  WORKDIR   the host folder pi works in (mounted at /work). Defaults to the
            current directory. The session config+state is keyed to this folder.

WHAT IT DOES
  Seeds a per-workdir writable copy of your canonical anon-pi config into
  ~/.config/anon-pi/sessions/<hash>/agent, mounts it as pi's global config
  (${PI_AGENT_DIR_ENV}=<mount>, default ${DEFAULT_CONTAINER_AGENT_DIR}), mounts WORKDIR at
  ${CONTAINER_WORKDIR}, opens ONE direct hole to your local model, and runs pi with all other
  egress forced through the socks5h proxy, fail-closed. Requires \`netcage\`.

ENVIRONMENT
  ANON_PI_IMAGE   (required) image with \`pi\` on PATH. No image yet? Running
                  anon-pi without it prints a ready-to-build Dockerfile.pi
                  recipe; see the README (Providing a pi image).
  ANON_PI_LLM     (required) RFC1918/link-local IP[:port] of the local model
  ANON_PI_PROXY   socks5h URL (default ${DEFAULT_PROXY})
  ANON_PI_HOME    anon-pi home (default $XDG_CONFIG_HOME/anon-pi or ~/.config/anon-pi)
  ANON_PI_CONFIG  canonical seed dir (default <ANON_PI_HOME>/agent)
  ANON_PI_AGENT_MOUNT  absolute container path for pi's config (default
                  ${DEFAULT_CONTAINER_AGENT_DIR}; set to your image's ~/.pi/agent, e.g. /root/.pi/agent)

RESEED
  Reseed is manual: delete the session dir, e.g.
    rm -rf ~/.config/anon-pi/sessions/<hash>/agent
  and the next run re-seeds it from the canonical config.

PLATFORM
  Linux only (via netcage's netns/nft jail). On macOS/Windows it works only
  inside a Linux VM, where --allow-direct to a LAN model is VM-boundary-sensitive.
`;
