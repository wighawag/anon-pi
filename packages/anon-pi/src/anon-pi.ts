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
import {dirname, isAbsolute, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

/** The container path the workdir is mounted at (pi's cwd). */
export const CONTAINER_WORKDIR = '/work';

/**
 * The container path pi uses as its config+state home. anon-pi mounts a
 * PERSISTENT host dir here (Model B), so everything pi writes, sessions,
 * history, settings (your model choice), `pi install`ed extensions, downloaded
 * bin/fd, survives across launches. Statefulness is the default; --ephemeral
 * mounts a throwaway dir here instead.
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
	/** `import` source models.json override (ANON_PI_SOURCE_MODELS). */
	sourceModels?: string;
	/** The host pi agent dir override (PI_CODING_AGENT_DIR), used to find models.json. */
	piAgentDir?: string;
	/** When true, use a throwaway state home (no persistence). Default false. */
	ephemeral?: boolean;
	/** The seed version anon-pi stamps into a fresh home. Default SEED_VERSION. */
	seedVersion?: string;
}

/** The fully-resolved run plan cli.ts executes. */
export interface RunPlan {
	/** Absolute workdir on the host (mounted at /work). */
	workdir: string;
	/**
	 * The PERSISTENT per-workdir state dir on the host, mounted at the container's
	 * ~/.pi/agent. Everything pi writes here survives. For --ephemeral this is a
	 * throwaway path cli.ts creates + discards.
	 */
	stateDir: string;
	/** The canonical host models.json (from `import`) mounted read-only for the seed, or '' if absent. */
	configSeed: string;
	/** True when this workdir has no state yet (fresh home; the seed will run). */
	fresh: boolean;
	/** The argv passed to `netcage` (after the `netcage` program name). */
	netcageArgs: string[];
}

/** A user-facing error whose message is meant to be printed verbatim (no stack). */
export class AnonPiError extends Error {}

/** Resolve the anon-pi home dir (holds the seed). */
export function resolveAnonPiHome(env: AnonPiEnv): string {
	if (env.anonPiHome) return resolve(env.anonPiHome);
	const base =
		env.xdgConfigHome && env.xdgConfigHome.trim() !== ''
			? env.xdgConfigHome
			: join(env.home, '.config');
	return join(base, 'anon-pi');
}

/**
 * The CANONICAL host seed dir holding models.json (written by `anon-pi import`).
 * Mounted read-only so the first-launch seed can copy models.json into a fresh
 * persistent home. Workdir-independent (import does not need a workdir).
 */
export function resolveConfigSeed(env: AnonPiEnv): string {
	if (env.configSeed) return resolve(env.configSeed);
	return join(resolveAnonPiHome(env), 'agent');
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
 * The persistent per-workdir state dir on the host (mounted at the container's
 * ~/.pi/agent). Keyed by the workdir via pi's path-slug convention:
 *   <anonPiHome>/state/<slug>/agent
 */
export function stateAgentDir(env: AnonPiEnv, absWorkdir: string): string {
	return join(resolveAnonPiHome(env), 'state', pathSlug(absWorkdir), 'agent');
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

/** The result of picking the ANON_PI_LLM provider out of a host models.json. */
export interface ImportResult {
	/** The provider key (e.g. "llamacpp-router"). */
	name: string;
	/** The barebones models.json to write (just the matched provider). */
	models: PiModelsFile;
	/** True if the matched provider's apiKey looks like a REAL secret (warn). */
	apiKeyLooksReal: boolean;
}

/** apiKey values that are NOT real secrets (safe to carry into the seed). */
const BENIGN_API_KEYS = new Set(['', 'none', 'ollama', 'no-key', 'local']);

/**
 * PURE: given a parsed host models.json and the ANON_PI_LLM value, select the
 * provider whose baseUrl points at that host:port and return a barebones
 * models.json carrying ONLY that provider (verbatim, with its models). Throws
 * AnonPiError if nothing matches. Carries no other provider (so etherplay /
 * google / paid API keys never enter the seed).
 */
export function pickProviderForLlm(
	hostModels: PiModelsFile,
	llmDirect: string,
): ImportResult {
	const providers = hostModels.providers ?? {};
	const want = hostPortKey(llmDirect);

	const matches: string[] = [];
	for (const [name, p] of Object.entries(providers)) {
		if (!p || typeof p !== 'object' || !p.baseUrl) continue;
		if (hostPortKey(p.baseUrl) === want) matches.push(name);
	}

	if (matches.length === 0) {
		const known = Object.entries(providers)
			.filter(([, p]) => p && p.baseUrl)
			.map(([n, p]) => `  ${n}: ${p.baseUrl}`)
			.join('\n');
		throw new AnonPiError(
			`anon-pi import: no provider in your host models.json points at ANON_PI_LLM (${want}).\n` +
				(known
					? `Providers found:\n${known}\n`
					: 'No providers with a baseUrl were found.\n') +
				'Set ANON_PI_LLM to the host:port of a provider above, or add that provider to pi first.',
		);
	}

	const name = matches[0];
	const provider = providers[name];
	const key = (provider.apiKey ?? '').trim().toLowerCase();
	const apiKeyLooksReal = !BENIGN_API_KEYS.has(key);

	return {
		name,
		models: {providers: {[name]: provider}},
		apiKeyLooksReal,
	};
}

/**
 * The default host models.json path `import` reads FROM. Overridable via
 * ANON_PI_SOURCE_MODELS; defaults to the real pi config (~/.pi/agent/models.json
 * under the container-less host HOME, or PI_CODING_AGENT_DIR if the user set it).
 */
export function resolveSourceModelsPath(env: AnonPiEnv): string {
	if (env.sourceModels && env.sourceModels.trim() !== '') {
		return resolve(env.sourceModels);
	}
	const agentDir =
		env.piAgentDir && env.piAgentDir.trim() !== ''
			? env.piAgentDir
			: join(env.home, '.pi', 'agent');
	return join(agentDir, MODELS_FILE);
}

/**
 * Build the run plan from the environment + the (optional) workdir arg. PURE: it
 * resolves paths and composes the netcage argv, performing NO filesystem writes
 * or spawns. It THROWS AnonPiError for the required inputs (image, llm, proxy).
 *
 * Statefulness (Model B): a persistent per-workdir host dir is mounted at the
 * container's ~/.pi/agent, so pi's sessions/history/settings/extensions persist.
 * First-launch seed (Model C): when that home is FRESH, the container run
 * command promotes the image's staged defaults + the imported models.json into
 * it and stamps a marker; thereafter pi OWNS the home and nothing is clobbered.
 *
 * `modelsSeedExists` reports whether the canonical import models.json exists (so
 * it is mounted for the seed); `stateExists` reports whether this workdir's
 * state home already exists (so `fresh` is known).
 *
 * --ephemeral mounts NO writable state: pi writes to the container's own
 * filesystem, which netcage runs with `--rm`, so it is destroyed when the
 * container exits. Nothing writable ever touches a host path; there is no
 * cleanup and no leftover-on-crash. (The read-only models.json seed is still
 * mounted; it is a single file anon-pi never writes to.)
 */
export function buildRunPlan(
	env: AnonPiEnv,
	workdirArg: string | undefined,
	modelsSeedExists: (modelsJsonPath: string) => boolean,
	stateExists: (stateDir: string) => boolean,
): RunPlan {
	if (!env.image || env.image.trim() === '') {
		// dockerfilePath is injected (cli.ts resolves the shipped Dockerfile.pi via
		// import.meta.url; tests pass a fixed path). Every command is emitted
		// flush-left so it copy-pastes cleanly: an indented heredoc would bake
		// leading spaces into the Dockerfile and break the EOF terminator, so we
		// point at the shipped file instead of printing a heredoc.
		const df = env.dockerfilePath ?? 'Dockerfile.pi';
		const wv = env.webveilDockerfilePath ?? 'examples/Dockerfile.pi-webveil';
		throw new AnonPiError(
			'anon-pi: set ANON_PI_IMAGE to a container image that has `pi` on its PATH.\n' +
				'\n' +
				'No image yet? A ready Dockerfile.pi ships with anon-pi (it installs the\n' +
				'official @earendil-works/pi-coding-agent). Build it and point at it:\n' +
				'\n' +
				`podman build -t localhost/anon-pi-pi:latest -f "${df}" "$(dirname "${df}")"\n` +
				'export ANON_PI_IMAGE=localhost/anon-pi-pi:latest\n' +
				'\n' +
				'Or the fuller example with the pi-webveil extension + a local SearXNG\n' +
				'(anonymized web search):\n' +
				'\n' +
				`podman build -t localhost/anon-pi-webveil:latest -f "${wv}" "$(dirname "${wv}")"\n` +
				'export ANON_PI_IMAGE=localhost/anon-pi-webveil:latest\n' +
				'\n' +
				'See the README (Providing a pi image) for details and a community-image note.',
		);
	}
	if (!env.llmDirect || env.llmDirect.trim() === '') {
		throw new AnonPiError(
			'anon-pi: set ANON_PI_LLM to the RFC1918/link-local IP[:port] of the local model pi should reach directly (e.g. ANON_PI_LLM=192.168.1.150:8080). All other egress stays forced through the proxy.',
		);
	}
	if (!env.proxy || env.proxy.trim() === '') {
		// No default: this is an anonymity tool, so the proxy is REQUIRED and never
		// guessed (mirrors netcage, which fails closed without --proxy). A silent
		// default would anonymize through the wrong endpoint, or fail deep in the
		// jail with a confusing DNS error, if the guessed proxy is not actually up.
		throw new AnonPiError(
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
				'Only socks5h:// is accepted (plain socks5:// resolves DNS locally and leaks).',
		);
	}

	const home = env.home;
	if (!home || home.trim() === '') {
		throw new AnonPiError('anon-pi: could not resolve HOME.');
	}

	const raw =
		workdirArg && workdirArg.trim() !== '' ? workdirArg : process.cwd();
	const workdir = isAbsolute(raw) ? raw : resolve(raw);

	// Persistent per-workdir state home, unless --ephemeral (no writable mount).
	const ephemeral = env.ephemeral === true;
	const stateDir = ephemeral ? '' : stateAgentDir(env, workdir);
	// Ephemeral home is always fresh (the container's throwaway layer); a
	// persistent home is fresh iff its dir is absent.
	const fresh = ephemeral ? true : !stateExists(stateDir);

	// The canonical imported models.json is mounted (read-only) for the seed only
	// when it exists; pi can also start with no models and you add them in-session.
	const modelsSeed = join(resolveConfigSeed(env), MODELS_FILE);
	const haveModelsSeed = modelsSeedExists(modelsSeed);

	const proxy = env.proxy.trim();

	// netcage's --allow-direct wants a bare IP[:port]/CIDR (no scheme/path), but a
	// user naturally sets ANON_PI_LLM to a URL (http://192.168.1.150:8080). Strip
	// it to host:port with the same helper `import` uses to match providers, so a
	// URL, an ip:port, or a bare ip all work.
	const directTarget = hostPortKey(env.llmDirect);
	const seedVersion = env.seedVersion ?? SEED_VERSION;

	const netcageArgs = [
		'run',
		'--proxy',
		proxy,
		'--allow-direct',
		directTarget,
		'-it',
		'-v',
		workdir, // netcage defaults a target-less -v to /work and cwd to /work
	];
	// Persistent mode ONLY: mount the per-workdir state home at ~/.pi/agent
	// (Model B). --ephemeral mounts nothing writable: pi writes to the container's
	// own --rm layer, gone on exit, no host state.
	if (!ephemeral) {
		netcageArgs.push('-v', `${stateDir}:${CONTAINER_AGENT_DIR}`);
	}
	// Mount the imported models.json read-only for the first-launch seed, if any.
	if (haveModelsSeed) {
		netcageArgs.push('-v', `${modelsSeed}:${CONTAINER_MODELS_SEED}:ro`);
	}
	netcageArgs.push(env.image, 'sh', '-c', containerRunCmd(seedVersion));

	return {
		workdir,
		stateDir,
		configSeed: haveModelsSeed ? modelsSeed : '',
		fresh,
		netcageArgs,
	};
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
		dockerfilePath: shippedDockerfilePath(),
		webveilDockerfilePath: shippedWebveilDockerfilePath(),
		sourceModels: penv.ANON_PI_SOURCE_MODELS,
		piAgentDir: penv.PI_CODING_AGENT_DIR,
		ephemeral: isTruthy(penv.ANON_PI_EPHEMERAL),
	};
}

/** Whether an env-var string is set to a truthy value (1/true/yes, any case). */
function isTruthy(v: string | undefined): boolean {
	if (!v) return false;
	const s = v.trim().toLowerCase();
	return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

/** The --help text (kept here so it is covered by the same module). */
export const HELP = `anon-pi - launch pi inside a netcage (anonymized egress + one direct local model)

USAGE
  anon-pi [WORKDIR]     launch pi jailed, working in WORKDIR (default: cwd)
  anon-pi import        seed models.json from your local model

  WORKDIR   the host folder pi works in (mounted at ${CONTAINER_WORKDIR}; pi's cwd). Files pi
            writes there land on the host.

WHAT IT DOES
  Runs pi inside netcage with all web/DNS egress forced through the socks5h
  proxy (fail-closed) and ONE direct hole to your local model (ANON_PI_LLM).

  STATEFUL by default: a persistent per-workdir home
  (<ANON_PI_HOME>/state/<workdir>/agent) is mounted at the container's
  ~/.pi/agent, so your conversations, history, settings (model choice), and any
  extensions you \`pi install\` persist across launches. Re-running in the same
  folder resumes it. On a FRESH home, the image's staged defaults (extensions,
  trust) and your imported models.json are seeded in once; after that pi owns the
  home and nothing is overwritten. Requires \`netcage\`.

  --ephemeral (or ANON_PI_EPHEMERAL=1): mount NO writable state; pi writes to the
  container's own --rm layer, gone on exit. Nothing writable touches the host,
  no cleanup, no leftover-on-crash.

import
  Reads your host ~/.pi/agent/models.json, picks the provider whose baseUrl
  serves ANON_PI_LLM, and writes JUST that provider to the canonical seed
  (<ANON_PI_CONFIG>/models.json). No other provider's API keys, no sessions, no
  identity. It SEEDS a fresh home; models you later add inside pi persist and are
  never clobbered. Re-run with --force to overwrite the canonical seed.

ENVIRONMENT
  ANON_PI_IMAGE   (required for run) image with \`pi\` on PATH. No image yet?
                  Running anon-pi without it prints a ready-to-build
                  Dockerfile.pi recipe; see the README (Providing a pi image).
  ANON_PI_LLM     (required) RFC1918/link-local IP[:port] of the local model
  ANON_PI_PROXY   (required) socks5h URL of your proxy (Tor/wireproxy/ssh -D).
                  No default: the proxy is what anonymizes, so it is never guessed.
  ANON_PI_EPHEMERAL  set to 1 for a throwaway (non-persistent) session
  ANON_PI_HOME    anon-pi home (default $XDG_CONFIG_HOME/anon-pi or ~/.config/anon-pi)
  ANON_PI_CONFIG  canonical seed dir holding models.json (default <ANON_PI_HOME>/agent)
  ANON_PI_SOURCE_MODELS  (import) host models.json to read (default ~/.pi/agent/models.json)

RESET A SESSION
  Delete its state home to start fresh (re-seeds next launch):
    rm -rf <ANON_PI_HOME>/state/<workdir-slug>/agent

PLATFORM
  Linux only (via netcage's netns/nft jail). On macOS/Windows it works only
  inside a Linux VM, where --allow-direct to a LAN model is VM-boundary-sensitive.
`;
