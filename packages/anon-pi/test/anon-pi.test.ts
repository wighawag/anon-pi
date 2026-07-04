import {describe, it, expect} from 'vitest';
import {resolve as pathResolve} from 'node:path';
import {
	AnonPiError,
	builtinProjectsRoot,
	generateModelsJson,
	hostPortKey,
	machineDir,
	machineHomeDir,
	machineJsonPath,
	parseConfigJson,
	parseMachineJson,
	pathSlug,
	resolveAnonPiHome,
	resolveLlm,
	resolveProjectsRoot,
	resolveProxy,
	type AnonPiConfig,
	type AnonPiEnv,
	type MachineConfig,
} from '../src/index.js';

const base: AnonPiEnv = {
	home: '/home/u',
	image: 'my/pi:tag',
	llmDirect: '192.168.1.150:8080',
	proxy: 'socks5h://127.0.0.1:9050',
};

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

describe("pathSlug (pi's session-dir convention, not a hash)", () => {
	it('wraps in -- and maps / \\ : to -', () => {
		expect(pathSlug('/home/u/dev/x')).toBe('--home-u-dev-x--');
		expect(pathSlug('/work')).toBe('--work--');
	});
});
