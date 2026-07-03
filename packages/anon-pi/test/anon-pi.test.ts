import {describe, it, expect} from 'vitest';
import {resolve as pathResolve} from 'node:path';
import {
	AnonPiError,
	buildRunPlan,
	builtinProjectsRoot,
	CONTAINER_AGENT_DIR,
	envFromProcess,
	generateModelsJson,
	hostPortKey,
	machineDir,
	machineHomeDir,
	machineJsonPath,
	parseConfigJson,
	parseMachineJson,
	pathSlug,
	pickProviderForLlm,
	resolveAnonPiHome,
	resolveConfigSeed,
	resolveLlm,
	resolveProjectsRoot,
	resolveProxy,
	resolveSourceModelsPath,
	stateAgentDir,
	type AnonPiConfig,
	type AnonPiEnv,
	type MachineConfig,
	type PiModelsFile,
} from '../src/index.js';

const base: AnonPiEnv = {
	home: '/home/u',
	image: 'my/pi:tag',
	llmDirect: '192.168.1.150:8080',
	proxy: 'socks5h://127.0.0.1:9050',
};

// models-seed present, state fresh (the common first-launch case)
const seedPresent = () => true;
const stateFresh = () => false;
const statePresent = () => true;
// plan(env, workdir) with models-seed present + a fresh state home
const plan = (env: AnonPiEnv, wd = '/work/recon') =>
	buildRunPlan(env, wd, seedPresent, stateFresh);

describe('path resolution', () => {
	it('defaults the anon-pi home to ~/.anon-pi (NOT ~/.config)', () => {
		expect(resolveAnonPiHome(base)).toBe('/home/u/.anon-pi');
	});

	it('does NOT put the new home under XDG_CONFIG_HOME', () => {
		// the dedicated, browsable workspace folder lives at ~/.anon-pi, not
		// under ~/.config, so XDG_CONFIG_HOME no longer moves it.
		expect(resolveAnonPiHome({...base, xdgConfigHome: '/cfg'})).toBe(
			'/home/u/.anon-pi',
		);
	});

	it('honours ANON_PI_HOME override', () => {
		expect(resolveAnonPiHome({...base, anonPiHome: '/opt/ap'})).toBe('/opt/ap');
	});

	// NOTE: resolveConfigSeed keeps the LEGACY ~/.config/anon-pi default on
	// purpose (it + ANON_PI_CONFIG are read by the still-present old import path;
	// they are retired by a later task). See the ## Decisions note in the done
	// record.
	it('defaults the seed to the legacy <~/.config/anon-pi>/agent', () => {
		expect(resolveConfigSeed(base)).toBe('/home/u/.config/anon-pi/agent');
	});

	it('honours ANON_PI_CONFIG seed override', () => {
		expect(resolveConfigSeed({...base, configSeed: '/seed'})).toBe('/seed');
	});
});

describe('workspace layout (machines + projects)', () => {
	it('machineDir is <home>/machines/<name>', () => {
		expect(machineDir(base, 'recon')).toBe('/home/u/.anon-pi/machines/recon');
		expect(machineDir({...base, anonPiHome: '/opt/ap'}, 'recon')).toBe(
			'/opt/ap/machines/recon',
		);
	});

	it('machineHomeDir is <home>/machines/<name>/home (bind-mounted at /root)', () => {
		expect(machineHomeDir(base, 'recon')).toBe(
			'/home/u/.anon-pi/machines/recon/home',
		);
	});

	it('machineJsonPath is <home>/machines/<name>/machine.json', () => {
		expect(machineJsonPath(base, 'recon')).toBe(
			'/home/u/.anon-pi/machines/recon/machine.json',
		);
	});

	it('builtinProjectsRoot is the default global <home>/projects', () => {
		expect(builtinProjectsRoot(base)).toBe('/home/u/.anon-pi/projects');
	});
});

describe('parseConfigJson (config.json shape)', () => {
	it('parses { proxy, llm, defaultMachine, projects? }', () => {
		const c = parseConfigJson({
			proxy: 'socks5h://127.0.0.1:9050',
			llm: '192.168.1.150:8080',
			defaultMachine: 'recon',
			projects: '/data/projects',
		});
		expect(c).toEqual({
			proxy: 'socks5h://127.0.0.1:9050',
			llm: '192.168.1.150:8080',
			defaultMachine: 'recon',
			projects: '/data/projects',
		});
	});

	it('tolerates an absent/partial config (all fields optional)', () => {
		expect(parseConfigJson({})).toEqual({});
		expect(parseConfigJson(undefined)).toEqual({});
		expect(parseConfigJson(null)).toEqual({});
	});

	it('ignores non-string fields (defensive against a hand-edited file)', () => {
		const c = parseConfigJson({proxy: 123, projects: {}, defaultMachine: []});
		expect(c.proxy).toBeUndefined();
		expect(c.projects).toBeUndefined();
		expect(c.defaultMachine).toBeUndefined();
	});
});

describe('parseMachineJson (machine.json shape)', () => {
	it('parses { image, projects? }', () => {
		expect(
			parseMachineJson({image: 'my/pi:tag', projects: '/m/projects'}),
		).toEqual({image: 'my/pi:tag', projects: '/m/projects'});
	});

	it('tolerates an absent/partial machine.json', () => {
		expect(parseMachineJson({})).toEqual({});
		expect(parseMachineJson(undefined)).toEqual({});
	});
});

describe('resolveProjectsRoot (env > machine > config > built-in)', () => {
	const cfg: AnonPiConfig = {projects: '/config/projects'};
	const machine: MachineConfig = {projects: '/machine/projects'};

	it('falls back to the built-in <home>/projects when nothing is set', () => {
		expect(resolveProjectsRoot({env: base})).toBe('/home/u/.anon-pi/projects');
	});

	it('config.projects overrides the built-in', () => {
		expect(resolveProjectsRoot({env: base, config: cfg})).toBe(
			'/config/projects',
		);
	});

	it('machine.projects overrides config.projects', () => {
		expect(resolveProjectsRoot({env: base, config: cfg, machine})).toBe(
			'/machine/projects',
		);
	});

	it('env ANON_PI_PROJECTS overrides machine + config', () => {
		expect(
			resolveProjectsRoot({
				env: {...base, projects: '/env/projects'},
				config: cfg,
				machine,
			}),
		).toBe('/env/projects');
	});

	it('the later --mount CLI override slots on top of env', () => {
		// documented top layer: cli.ts passes a resolved mountParent later.
		expect(
			resolveProjectsRoot({
				env: {...base, projects: '/env/projects'},
				config: cfg,
				machine,
				mountParent: '/host/dev',
			}),
		).toBe('/host/dev');
	});

	it('resolves a relative override to an absolute path', () => {
		expect(
			resolveProjectsRoot({env: base, config: {projects: 'rel/projects'}}),
		).toBe(pathResolve('rel/projects'));
	});
});

describe('resolveProxy (env over config; REQUIRED / fail-closed)', () => {
	it('uses config.proxy when env has none', () => {
		expect(resolveProxy({config: {proxy: 'socks5h://c:1'}, env: {}})).toBe(
			'socks5h://c:1',
		);
	});

	it('env ANON_PI_PROXY overrides config.proxy', () => {
		expect(
			resolveProxy({
				config: {proxy: 'socks5h://c:1'},
				env: {proxy: 'socks5h://e:2'},
			}),
		).toBe('socks5h://e:2');
	});

	it('fails closed with the verbatim guidance when neither supplies a proxy', () => {
		expect(() => resolveProxy({config: {}, env: {}})).toThrow(AnonPiError);
		let msg = '';
		try {
			resolveProxy({config: {}, env: {}});
		} catch (e) {
			msg = (e as Error).message;
		}
		expect(msg).toMatch(/never guessed|no default/i);
		expect(msg).toContain('export ANON_PI_PROXY=socks5h://127.0.0.1:9050'); // Tor
		expect(msg).toContain('export ANON_PI_PROXY=socks5h://127.0.0.1:1080'); // wireproxy
		// same verbatim message the legacy buildRunPlan emits (single source)
		let planMsg = '';
		try {
			buildRunPlan(
				{...base, proxy: ''},
				'/w',
				() => true,
				() => false,
			);
		} catch (e) {
			planMsg = (e as Error).message;
		}
		expect(msg).toBe(planMsg);
	});

	it('treats a blank/whitespace proxy as missing (fail-closed)', () => {
		expect(() =>
			resolveProxy({config: {proxy: '   '}, env: {proxy: ''}}),
		).toThrow(AnonPiError);
	});
});

describe('resolveLlm (env over config)', () => {
	it('uses config.llm when env has none', () => {
		expect(resolveLlm({config: {llm: '10.0.0.1:1'}, env: {}})).toBe(
			'10.0.0.1:1',
		);
	});

	it('env ANON_PI_LLM overrides config.llm', () => {
		expect(
			resolveLlm({config: {llm: '10.0.0.1:1'}, env: {llmDirect: '10.0.0.2:2'}}),
		).toBe('10.0.0.2:2');
	});

	it('returns undefined when neither supplies an llm (not fail-closed here)', () => {
		expect(resolveLlm({config: {}, env: {}})).toBeUndefined();
	});
});

describe('hostPortKey (ANON_PI_LLM vs provider baseUrl matching)', () => {
	it('strips scheme and path so the LLM value matches a baseUrl', () => {
		expect(hostPortKey('192.168.1.150:8080')).toBe('192.168.1.150:8080');
		expect(hostPortKey('http://192.168.1.150:8080/v1')).toBe(
			'192.168.1.150:8080',
		);
	});

	it('lowercases and drops user:pass@', () => {
		expect(hostPortKey('https://User:Pass@Host:1234/x')).toBe('host:1234');
	});

	it('handles a host with no port', () => {
		expect(hostPortKey('http://model.local/v1')).toBe('model.local');
	});
});

describe('generateModelsJson (endpoint-driven, no host read)', () => {
	// every endpoint form normalises to the same host:port via hostPortKey, so
	// they all produce the SAME single-provider models.json.
	const forms = [
		'192.168.1.150:8080',
		'http://192.168.1.150:8080',
		'http://192.168.1.150:8080/v1',
		'HTTP://192.168.1.150:8080/v1',
	];

	it('generates a barebones models.json from each endpoint form', () => {
		for (const llm of forms) {
			const m = generateModelsJson(llm);
			const names = Object.keys(m.providers ?? {});
			// ONLY the one local provider (no host secrets, no other providers)
			expect(names).toHaveLength(1);
			const provider = m.providers?.[names[0]];
			expect(provider).toBeDefined();
			// baseUrl points at the normalised host:port (scheme/path stripped, lowercased)
			expect(provider?.baseUrl).toContain('192.168.1.150:8080');
		}
	});

	it('carries ONLY the one local provider (no other providers)', () => {
		const m = generateModelsJson('192.168.1.150:8080');
		expect(Object.keys(m.providers ?? {})).toHaveLength(1);
	});

	it('normalises the endpoint via hostPortKey into the baseUrl', () => {
		const m = generateModelsJson('http://User:Pass@192.168.1.150:8080/v1');
		const name = Object.keys(m.providers ?? {})[0];
		const baseUrl = m.providers?.[name]?.baseUrl ?? '';
		// user:pass@ dropped, scheme/path stripped from the host:port core
		expect(baseUrl).toContain('192.168.1.150:8080');
		expect(baseUrl).not.toContain('User');
		expect(baseUrl).not.toContain('Pass');
	});

	it('handles a bare host with no port', () => {
		const m = generateModelsJson('http://model.local/v1');
		const name = Object.keys(m.providers ?? {})[0];
		expect(m.providers?.[name]?.baseUrl).toContain('model.local');
	});

	it('carries no real apiKey (a benign local placeholder only)', () => {
		const m = generateModelsJson('192.168.1.150:8080');
		const name = Object.keys(m.providers ?? {})[0];
		const key = (m.providers?.[name]?.apiKey ?? '').toLowerCase();
		expect(['', 'none', 'no-key', 'local', 'ollama']).toContain(key);
	});

	it('is a plain object with no host-file provenance', () => {
		// endpoint in -> object out; the generator NEVER reads a host models.json,
		// so two calls with the same endpoint are deep-equal (pure).
		expect(generateModelsJson('192.168.1.150:8080')).toEqual(
			generateModelsJson('192.168.1.150:8080'),
		);
	});
});

describe('pickProviderForLlm (import selection)', () => {
	const host: PiModelsFile = {
		providers: {
			etherplay: {
				api: 'anthropic-messages',
				apiKey: 'REALSECRET123',
				baseUrl: 'https://claude.example.io',
				models: [{id: 'x'}],
			},
			llamacpp: {
				api: 'openai-completions',
				apiKey: 'none',
				baseUrl: 'http://192.168.1.150:8080/v1',
				models: [{id: 'a'}, {id: 'b'}],
			},
		},
	};

	it('picks ONLY the provider whose baseUrl serves ANON_PI_LLM', () => {
		const r = pickProviderForLlm(host, '192.168.1.150:8080');
		expect(r.name).toBe('llamacpp');
		expect(Object.keys(r.models.providers ?? {})).toEqual(['llamacpp']);
		// the paid/real-key provider is NOT carried into the seed
		expect(r.models.providers?.etherplay).toBeUndefined();
	});

	it('carries the matched provider verbatim (its models included)', () => {
		const r = pickProviderForLlm(host, '192.168.1.150:8080');
		expect(r.models.providers?.llamacpp?.models).toHaveLength(2);
		expect(r.models.providers?.llamacpp?.baseUrl).toBe(
			'http://192.168.1.150:8080/v1',
		);
	});

	it('does not flag a benign local apiKey as real', () => {
		const r = pickProviderForLlm(host, '192.168.1.150:8080');
		expect(r.apiKeyLooksReal).toBe(false);
	});

	it('flags a real-looking apiKey on the matched provider', () => {
		const r = pickProviderForLlm(
			{providers: {p: {baseUrl: 'http://10.0.0.5:1/v1', apiKey: 'sk-abc123'}}},
			'10.0.0.5:1',
		);
		expect(r.apiKeyLooksReal).toBe(true);
	});

	it('throws AnonPiError (listing providers) when nothing matches', () => {
		expect(() => pickProviderForLlm(host, '10.9.9.9:9999')).toThrow(
			AnonPiError,
		);
		try {
			pickProviderForLlm(host, '10.9.9.9:9999');
		} catch (e) {
			const msg = (e as Error).message;
			expect(msg).toContain('10.9.9.9:9999');
			expect(msg).toContain('llamacpp'); // lists known providers
		}
	});
});

describe('resolveSourceModelsPath (import reads FROM)', () => {
	it('defaults to ~/.pi/agent/models.json', () => {
		expect(resolveSourceModelsPath(base)).toBe('/home/u/.pi/agent/models.json');
	});

	it('honours PI_CODING_AGENT_DIR', () => {
		expect(resolveSourceModelsPath({...base, piAgentDir: '/opt/pi'})).toBe(
			'/opt/pi/models.json',
		);
	});

	it('honours ANON_PI_SOURCE_MODELS override', () => {
		expect(
			resolveSourceModelsPath({...base, sourceModels: '/x/models.json'}),
		).toBe('/x/models.json');
	});
});

describe('buildRunPlan required inputs', () => {
	it('throws AnonPiError when ANON_PI_IMAGE is missing', () => {
		expect(() => plan({...base, image: ''})).toThrow(/ANON_PI_IMAGE/);
	});

	it('throws AnonPiError when ANON_PI_LLM is missing', () => {
		expect(() => plan({...base, llmDirect: ''})).toThrow(/ANON_PI_LLM/);
	});

	it('requires ANON_PI_PROXY (no default: the proxy is what anonymizes)', () => {
		expect(() => plan({...base, proxy: ''})).toThrow(/ANON_PI_PROXY/);
		expect(() => plan({...base, proxy: undefined})).toThrow(
			/never guessed|no default/i,
		);
	});

	it('the missing-proxy error offers copy-paste Tor + wireproxy options', () => {
		let msg = '';
		try {
			plan({...base, proxy: ''});
		} catch (e) {
			msg = (e as Error).message;
		}
		for (const line of msg.split('\n')) {
			if (line.startsWith('export ')) continue;
			expect(/^\s+export\b/.test(line)).toBe(false);
		}
		expect(msg).toContain('export ANON_PI_PROXY=socks5h://127.0.0.1:9050'); // Tor
		expect(msg).toContain('export ANON_PI_PROXY=socks5h://127.0.0.1:1080'); // wireproxy/ssh
		expect(msg.toLowerCase()).toContain('tor');
		expect(msg.toLowerCase()).toContain('wireproxy');
	});

	it('missing-image error is copy-pasteable and mentions both Dockerfiles', () => {
		let msg = '';
		try {
			plan({
				...base,
				image: '',
				dockerfilePath: '/pkg/Dockerfile.pi',
				webveilDockerfilePath: '/pkg/examples/Dockerfile.pi-webveil',
			});
		} catch (e) {
			msg = (e as Error).message;
		}
		for (const line of msg.split('\n')) {
			if (line.startsWith('podman ') || line.startsWith('export ')) continue;
			expect(/^\s+(podman|export)\b/.test(line)).toBe(false);
		}
		expect(msg).toContain('podman build');
		expect(msg).toContain('/pkg/Dockerfile.pi');
		expect(msg).toContain('/pkg/examples/Dockerfile.pi-webveil');
		expect(msg).not.toContain("<<'EOF'");
	});
});

describe("pathSlug (pi's session-dir convention, not a hash)", () => {
	it('wraps in -- and maps / \\ : to -', () => {
		expect(pathSlug('/home/u/dev/x')).toBe('--home-u-dev-x--');
		expect(pathSlug('/work')).toBe('--work--');
	});
});

describe('stateAgentDir (persistent per-workdir home)', () => {
	it('is <home>/state/<slug>/agent', () => {
		expect(stateAgentDir(base, '/home/me/proj')).toBe(
			'/home/u/.config/anon-pi/state/--home-me-proj--/agent',
		);
	});
});

describe('buildRunPlan statefulness', () => {
	it('mounts the persistent per-workdir home at the container agent dir', () => {
		const p = plan(base, '/home/me/proj');
		const stateDir = stateAgentDir(base, '/home/me/proj');
		expect(p.stateDir).toBe(stateDir);
		expect(p.netcageArgs).toContain(`${stateDir}:${CONTAINER_AGENT_DIR}`);
		// NOT the old shadow-prone PI_CODING_AGENT_DIR mount
		expect(p.netcageArgs.join(' ')).not.toContain('PI_CODING_AGENT_DIR');
	});

	it('reports fresh=true when the state home is absent, false when present', () => {
		expect(buildRunPlan(base, '/w', seedPresent, stateFresh).fresh).toBe(true);
		expect(buildRunPlan(base, '/w', seedPresent, statePresent).fresh).toBe(
			false,
		);
	});

	it('mounts the imported models.json read-only for the seed when present', () => {
		const p = plan(base);
		expect(p.netcageArgs).toContain(
			`${resolveConfigSeed(base)}/models.json:/anon-pi-seed/models.json:ro`,
		);
	});

	it('omits the models.json mount when the import seed is absent', () => {
		const p = buildRunPlan(base, '/w', () => false, stateFresh);
		// no -v ...:/anon-pi-seed/models.json:ro mount (the run cmd still references
		// the path in its conditional cp, guarded by [ -f ], so check the mount arg)
		expect(
			p.netcageArgs.some((a) => a.endsWith(':/anon-pi-seed/models.json:ro')),
		).toBe(false);
		expect(p.configSeed).toBe('');
	});

	it('--ephemeral mounts NO writable state (pi writes to the --rm container layer)', () => {
		const p = buildRunPlan(
			{...base, ephemeral: true},
			'/w',
			seedPresent,
			statePresent, // ignored for ephemeral
		);
		expect(p.stateDir).toBe(''); // no host state dir at all
		expect(p.fresh).toBe(true); // the container's throwaway home is always fresh
		// NO -v ...:/root/.pi/agent mount: nothing writable touches the host
		expect(
			p.netcageArgs.some((a) => a.endsWith(`:${CONTAINER_AGENT_DIR}`)),
		).toBe(false);
		// the read-only models.json seed is still mounted (single file, never written)
		expect(
			p.netcageArgs.some((a) => a.endsWith(':/anon-pi-seed/models.json:ro')),
		).toBe(true);
	});
});

describe('buildRunPlan netcage argv', () => {
	it('starts with run + the configured proxy', () => {
		expect(plan(base).netcageArgs.slice(0, 3)).toEqual([
			'run',
			'--proxy',
			'socks5h://127.0.0.1:9050',
		]);
	});

	it('uses the ANON_PI_PROXY value verbatim', () => {
		expect(
			plan({...base, proxy: 'socks5h://10.0.0.5:9050'}, '/w').netcageArgs[2],
		).toBe('socks5h://10.0.0.5:9050');
	});

	it('opens exactly one direct hole for the local model', () => {
		const args = plan(base).netcageArgs;
		const i = args.indexOf('--allow-direct');
		expect(i).toBeGreaterThan(-1);
		expect(args[i + 1]).toBe('192.168.1.150:8080');
		expect(args.filter((a) => a === '--allow-direct')).toHaveLength(1);
	});

	it('normalizes a URL-form ANON_PI_LLM for --allow-direct (strips scheme/path)', () => {
		for (const llm of [
			'http://192.168.1.150:8080',
			'http://192.168.1.150:8080/v1',
			'192.168.1.150:8080',
		]) {
			const args = plan({...base, llmDirect: llm}, '/w').netcageArgs;
			const i = args.indexOf('--allow-direct');
			expect(args[i + 1]).toBe('192.168.1.150:8080');
		}
	});

	it('is interactive', () => {
		expect(plan(base).netcageArgs).toContain('-it');
	});

	it('mounts the workdir (target-less -v, netcage defaults it to /work)', () => {
		expect(plan(base).netcageArgs).toContain('/work/recon');
	});

	it('runs pi via a seed-if-fresh then exec-pi shell step', () => {
		const args = plan(base).netcageArgs;
		const i = args.indexOf('my/pi:tag');
		expect(i).toBeGreaterThan(-1);
		expect(args[i + 1]).toBe('sh');
		expect(args[i + 2]).toBe('-c');
		const cmd = args[i + 3];
		// seed only if the marker is absent (fresh home), then exec pi
		expect(cmd).toContain('.anon-pi-seed');
		expect(cmd).toContain('/opt/anon-pi-seed/agent'); // image-staged defaults
		expect(cmd).toContain('/anon-pi-seed/models.json'); // imported models
		expect(cmd).toContain('exec pi');
	});
});

describe('envFromProcess mapping', () => {
	it('maps the ANON_PI_* vars and falls back HOME', () => {
		const env = envFromProcess({
			HOME: '/home/z',
			ANON_PI_IMAGE: 'img',
			ANON_PI_LLM: '10.0.0.9:1234',
			ANON_PI_PROXY: 'socks5h://p:1',
			ANON_PI_HOME: '/ah',
			ANON_PI_CONFIG: '/seed',
			XDG_CONFIG_HOME: '/xdg',
			ANON_PI_SOURCE_MODELS: '/src/models.json',
			PI_CODING_AGENT_DIR: '/opt/pi',
			ANON_PI_EPHEMERAL: '1',
			ANON_PI_PROJECTS: '/data/projects',
		});
		expect(env).toMatchObject({
			home: '/home/z',
			image: 'img',
			llmDirect: '10.0.0.9:1234',
			proxy: 'socks5h://p:1',
			anonPiHome: '/ah',
			configSeed: '/seed',
			xdgConfigHome: '/xdg',
			sourceModels: '/src/models.json',
			piAgentDir: '/opt/pi',
			ephemeral: true,
			projects: '/data/projects',
		});
	});

	it('ephemeral is false unless ANON_PI_EPHEMERAL is truthy', () => {
		expect(envFromProcess({}).ephemeral).toBe(false);
		expect(envFromProcess({ANON_PI_EPHEMERAL: 'yes'}).ephemeral).toBe(true);
		expect(envFromProcess({ANON_PI_EPHEMERAL: '0'}).ephemeral).toBe(false);
	});
});
