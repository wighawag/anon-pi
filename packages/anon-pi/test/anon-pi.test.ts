import {describe, it, expect} from 'vitest';
import {resolve as pathResolve} from 'node:path';
import {
	AnonPiError,
	apiKeyLooksReal,
	builtinProjectsRoot,
	generateModelsJson,
	generateModelSelection,
	globalModelsSeedPath,
	globalSettingsSeedPath,
	machineModelsSeedPath,
	mergeModelSelection,
	mergeModelSources,
	parseModelsListing,
	pickLocalProviderModels,
	resolveHostModelsPath,
	resolveModelsSeedPath,
	resolveSettingsSeedPath,
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
	type PiModelsFile,
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

describe('model import: parseModelsListing (/v1/models shapes)', () => {
	it('extracts ids from an OpenAI-style { data: [{ id }] } body', () => {
		expect(
			parseModelsListing({data: [{id: 'a'}, {id: 'b'}, {id: '  c '}]}),
		).toEqual(['a', 'b', 'c']);
	});
	it('accepts a { models: [...] } body and a bare array', () => {
		expect(parseModelsListing({models: [{id: 'x'}]})).toEqual(['x']);
		expect(parseModelsListing(['p', 'q'])).toEqual(['p', 'q']);
	});
	it('tolerates garbage / missing (returns [])', () => {
		expect(parseModelsListing(undefined)).toEqual([]);
		expect(parseModelsListing({})).toEqual([]);
		expect(parseModelsListing({data: 'nope'})).toEqual([]);
		expect(parseModelsListing({data: [{}, {id: 3}, {id: ''}]})).toEqual([]);
	});
});

describe('model import: apiKeyLooksReal (benign vs secret)', () => {
	it('treats benign placeholders as NOT real', () => {
		for (const k of [
			'',
			'none',
			'NONE',
			'ollama',
			'no-key',
			'local',
			undefined,
		]) {
			expect(apiKeyLooksReal(k)).toBe(false);
		}
	});
	it('treats anything else as a real secret', () => {
		expect(apiKeyLooksReal('sk-abc123')).toBe(true);
		expect(apiKeyLooksReal('hf_xxx')).toBe(true);
	});
});

describe('model import: pickLocalProviderModels (endpoint-scoped)', () => {
	const host: PiModelsFile = {
		providers: {
			etherplay: {
				baseUrl: 'https://claude.etherplay.io',
				apiKey: 'sk-REALSECRET',
				models: [{id: 'claude-opus'}],
			},
			'llamacpp-router': {
				baseUrl: 'http://192.168.1.150:8080/v1',
				apiKey: 'none',
				models: [
					{id: 'Hermes-3-70B', name: 'Hermes 3 70B', contextWindow: 131072},
					{id: 'qwen3-coder-30B'},
				],
			},
		},
	};

	it('returns ONLY the provider matching the endpoint (anonymity scoping)', () => {
		const m = pickLocalProviderModels(host, '192.168.1.150:8080');
		expect(m).toBeDefined();
		expect(m!.models.map((x) => x.id)).toEqual([
			'Hermes-3-70B',
			'qwen3-coder-30B',
		]);
		// the etherplay provider (a paid API + a REAL key) is NEVER considered.
		expect(m!.apiKey).toBe('none');
		expect(m!.apiKeyLooksReal).toBe(false);
	});

	it('preserves the matching entry config (contextWindow etc.)', () => {
		const m = pickLocalProviderModels(host, 'http://192.168.1.150:8080/v1');
		const hermes = m!.models.find((x) => x.id === 'Hermes-3-70B');
		expect(hermes?.contextWindow).toBe(131072);
		expect(hermes?.name).toBe('Hermes 3 70B');
	});

	it('flags a REAL apiKey on the matching provider', () => {
		const withKey: PiModelsFile = {
			providers: {
				local: {
					baseUrl: 'http://10.0.0.9:8080/v1',
					apiKey: 'sk-real',
					models: [],
				},
			},
		};
		const m = pickLocalProviderModels(withKey, '10.0.0.9:8080');
		expect(m!.apiKeyLooksReal).toBe(true);
	});

	it('returns undefined when no provider matches the endpoint', () => {
		expect(pickLocalProviderModels(host, '10.9.9.9:1234')).toBeUndefined();
	});
});

describe('model import: mergeModelSources (configured + server)', () => {
	const configured = [
		{
			id: 'Hermes-3-70B',
			name: 'Hermes 3 70B',
			cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
		},
	];
	it('marks host entries [configured] and endpoint-only ids [server]', () => {
		const merged = mergeModelSources(configured, [
			'Hermes-3-70B',
			'default',
			'qwen',
		]);
		const byId = Object.fromEntries(merged.map((c) => [c.id, c.configured]));
		expect(byId['Hermes-3-70B']).toBe(true); // host wins (configured)
		expect(byId['default']).toBe(false); // server-only
		expect(byId['qwen']).toBe(false);
		// sorted (localeCompare, case-insensitive) + deduped
		expect(merged.map((c) => c.id)).toEqual([
			'default',
			'Hermes-3-70B',
			'qwen',
		]);
	});
	it('keeps the rich entry for a configured id present in both', () => {
		const merged = mergeModelSources(configured, ['Hermes-3-70B']);
		const h = merged.find((c) => c.id === 'Hermes-3-70B');
		expect((h!.entry as {name?: string}).name).toBe('Hermes 3 70B');
	});
});

describe('model import: generateModelsJson with full entries + apiKey', () => {
	it('carries full model entries and the passed apiKey', () => {
		const models = [
			{
				id: 'B',
				name: 'B',
				contextWindow: 8192,
				cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
			},
			{
				id: 'A',
				name: 'A',
				cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
			},
		];
		const m = generateModelsJson('192.168.1.150:8080', models, 'none');
		const p = m.providers!.local;
		// sorted by id, deduped, verbatim config preserved
		expect((p.models as {id: string}[]).map((x) => x.id)).toEqual(['A', 'B']);
		expect((p.models as {contextWindow?: number}[])[1].contextWindow).toBe(
			8192,
		);
		expect(p.apiKey).toBe('none');
		expect(p.baseUrl).toBe('http://192.168.1.150:8080/v1');
	});
	it('still accepts bare id strings (server-only path)', () => {
		const m = generateModelsJson('10.0.0.1:1', ['m1', 'm2']);
		expect(
			(m.providers!.local.models as {id: string}[]).map((x) => x.id),
		).toEqual(['m1', 'm2']);
	});
});

describe('model import: settings selection + merge', () => {
	it('generateModelSelection sets defaultProvider/defaultModel/enabledModels', () => {
		const sel = generateModelSelection(['B', 'A'], 'A');
		expect(sel.defaultProvider).toBe('local');
		expect(sel.defaultModel).toBe('A');
		expect(sel.enabledModels).toEqual(['local/A', 'local/B']); // sorted, prefixed
	});
	it('mergeModelSelection overwrites ONLY the 3 keys, preserving the rest', () => {
		const existing = {
			packages: ['npm:pi-subagents'],
			defaultModel: 'old',
			defaultProvider: 'etherplay',
			hideThinkingBlock: true,
		};
		const sel = generateModelSelection(['A'], 'A');
		const merged = mergeModelSelection(existing, sel);
		expect(merged.packages).toEqual(['npm:pi-subagents']); // preserved
		expect(merged.hideThinkingBlock).toBe(true); // preserved
		expect(merged.defaultProvider).toBe('local'); // overwritten
		expect(merged.defaultModel).toBe('A'); // overwritten
		expect(merged.enabledModels).toEqual(['local/A']);
	});
	it('mergeModelSelection tolerates a missing/garbage base', () => {
		const sel = generateModelSelection(['A'], 'A');
		expect(mergeModelSelection(undefined, sel).defaultModel).toBe('A');
		expect(mergeModelSelection('nope', sel).defaultProvider).toBe('local');
	});
});

describe('resolveHostModelsPath', () => {
	it('defaults to ~/.pi/agent/models.json', () => {
		expect(resolveHostModelsPath(base)).toBe('/home/u/.pi/agent/models.json');
	});
	it('honours PI_CODING_AGENT_DIR (piAgentDir)', () => {
		expect(resolveHostModelsPath({...base, piAgentDir: '/opt/pi'})).toBe(
			'/opt/pi/models.json',
		);
	});
});

describe('GLOBAL model seed + per-machine override precedence', () => {
	// the local model is a workspace-level thing (one global `llm`), so its seed
	// is global and shared by every machine; a machine may override it.
	it('global seed paths are at the workspace root', () => {
		expect(globalModelsSeedPath(base)).toBe('/home/u/.anon-pi/models.json');
		expect(globalSettingsSeedPath(base)).toBe(
			'/home/u/.anon-pi/settings-seed.json',
		);
	});

	it('every machine resolves the GLOBAL seed when it has no override', () => {
		const onlyGlobal = new Set(['/home/u/.anon-pi/models.json']);
		const exists = (p: string) => onlyGlobal.has(p);
		expect(resolveModelsSeedPath(base, 'default', exists)).toBe(
			'/home/u/.anon-pi/models.json',
		);
		// a DIFFERENT machine resolves the SAME global seed (the fix's whole point)
		expect(resolveModelsSeedPath(base, 'webveil', exists)).toBe(
			'/home/u/.anon-pi/models.json',
		);
	});

	it('a per-machine models.json OVERRIDES the global for that machine only', () => {
		const override = machineModelsSeedPath(base, 'webveil');
		const present = new Set(['/home/u/.anon-pi/models.json', override]);
		const exists = (p: string) => present.has(p);
		// webveil wins with its own; default still gets the global
		expect(resolveModelsSeedPath(base, 'webveil', exists)).toBe(override);
		expect(resolveModelsSeedPath(base, 'default', exists)).toBe(
			'/home/u/.anon-pi/models.json',
		);
	});

	it('returns undefined when NEITHER a per-machine nor a global seed exists', () => {
		expect(resolveModelsSeedPath(base, 'default', () => false)).toBeUndefined();
		expect(
			resolveSettingsSeedPath(base, 'default', () => false),
		).toBeUndefined();
	});

	it('settings seed follows the same override > global precedence', () => {
		const gl = '/home/u/.anon-pi/settings-seed.json';
		expect(resolveSettingsSeedPath(base, 'm', (p) => p === gl)).toBe(gl);
	});
});

describe("pathSlug (pi's session-dir convention, not a hash)", () => {
	it('wraps in -- and maps / \\ : to -', () => {
		expect(pathSlug('/home/u/dev/x')).toBe('--home-u-dev-x--');
		expect(pathSlug('/work')).toBe('--work--');
	});
});
