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
	anonPiVersion,
	expandTilde,
	findingsFromNetcageDetect,
	processNoteFromNetcageDetect,
	resolveNetcageGraphroot,
	NETCAGE_DEFAULT_GRAPHROOT,
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
	resumeSessionId,
	sessionHeaderCwd,
	resolveAnonPiHome,
	resolveLlm,
	resolveProjectsRoot,
	projectsRootLeaksLogin,
	resolveInitProjectsDefault,
	crossAccountBinaryUnsuitable,
	anonPiVersionMismatch,
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

	it('parses the `hardened` boolean marker (docs/adr/0006), ignoring non-booleans', () => {
		expect(parseConfigJson({hardened: true}).hardened).toBe(true);
		expect(parseConfigJson({hardened: false}).hardened).toBe(false);
		// absent = non-hardened (undefined, not false-by-coercion).
		expect(parseConfigJson({}).hardened).toBeUndefined();
		// a hand-edited non-boolean is ignored.
		expect(parseConfigJson({hardened: 'yes'}).hardened).toBeUndefined();
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

describe('projectsRootLeaksLogin (hardened projects root must avoid the login home)', () => {
	const loginHome = '/home/wighawag';

	it('is false on a NON-hardened install regardless of the path', () => {
		expect(
			projectsRootLeaksLogin({
				projectsRoot: '/home/wighawag/dev',
				loginHome,
				hardened: false,
			}),
		).toBe(false);
	});

	it('LEAKS when hardened AND the root is under the login home', () => {
		expect(
			projectsRootLeaksLogin({
				projectsRoot: '/home/wighawag/dev/x',
				loginHome,
				hardened: true,
			}),
		).toBe(true);
	});

	it('LEAKS when the root IS the login home itself', () => {
		expect(
			projectsRootLeaksLogin({
				projectsRoot: '/home/wighawag',
				loginHome,
				hardened: true,
			}),
		).toBe(true);
	});

	it('does NOT leak for the anon account tree (a sibling home)', () => {
		expect(
			projectsRootLeaksLogin({
				projectsRoot: '/home/anon/.anon-pi/projects',
				loginHome,
				hardened: true,
			}),
		).toBe(false);
	});

	it('does NOT treat a sibling PREFIX-sharing dir as under the home', () => {
		// `/home/wighawag-old` shares the `/home/wighawag` string prefix but is NOT
		// under it; the separator-aware check must reject the naive startsWith.
		expect(
			projectsRootLeaksLogin({
				projectsRoot: '/home/wighawag-old/dev',
				loginHome,
				hardened: true,
			}),
		).toBe(false);
	});
});

describe('crossAccountBinaryUnsuitable (can the dedicated account run this anon-pi?)', () => {
	const loginHome = '/home/wighawag';

	it('SUITABLE: a system path (not under home, not a shim, not .js)', () => {
		expect(
			crossAccountBinaryUnsuitable({
				resolvedPath: '/usr/local/bin/anon-pi',
				loginHome,
			}),
		).toEqual({unsuitable: false});
		expect(
			crossAccountBinaryUnsuitable({
				resolvedPath: '/usr/bin/anon-pi',
				loginHome,
			}),
		).toEqual({unsuitable: false});
	});

	it('UNSUITABLE under-login-home: the Volta shim (the reported bug)', () => {
		expect(
			crossAccountBinaryUnsuitable({
				resolvedPath: '/home/wighawag/.volta/bin/volta-shim',
				loginHome,
			}),
		).toEqual({unsuitable: true, reason: 'under-login-home'});
	});

	it('UNSUITABLE version-manager-shim: a manager dir OUTSIDE the home', () => {
		// login home is /root here, so under-login-home does not fire; the `.nvm`
		// segment is what makes it a shim.
		expect(
			crossAccountBinaryUnsuitable({
				resolvedPath: '/opt/.nvm/versions/node/x/bin/anon-pi',
				loginHome: '/root',
			}),
		).toEqual({unsuitable: true, reason: 'version-manager-shim'});
	});

	it('UNSUITABLE non-executable-js: the cli.js fallback', () => {
		expect(
			crossAccountBinaryUnsuitable({
				resolvedPath: '/opt/anon-pi/dist/cli.js',
				loginHome: '/root',
			}),
		).toEqual({unsuitable: true, reason: 'non-executable-js'});
	});

	it('UNSUITABLE no-binary: empty/undefined path', () => {
		expect(
			crossAccountBinaryUnsuitable({resolvedPath: undefined, loginHome}),
		).toEqual({unsuitable: true, reason: 'no-binary'});
		expect(
			crossAccountBinaryUnsuitable({resolvedPath: '   ', loginHome}),
		).toEqual({unsuitable: true, reason: 'no-binary'});
	});

	it('does NOT trip on a sibling-prefix home dir (/home/wighawag-old)', () => {
		expect(
			crossAccountBinaryUnsuitable({
				resolvedPath: '/home/wighawag-old/bin/anon-pi',
				loginHome,
			}),
		).toEqual({unsuitable: false});
	});
});

describe('anonPiVersionMismatch (hardened login vs account version divergence)', () => {
	it('is TRUE when both known and different', () => {
		expect(anonPiVersionMismatch('0.25.2', '0.26.0')).toBe(true);
	});

	it('is FALSE when equal', () => {
		expect(anonPiVersionMismatch('0.26.0', '0.26.0')).toBe(false);
	});

	it('is FALSE when either is unknown (never block on missing info)', () => {
		expect(anonPiVersionMismatch(undefined, '0.26.0')).toBe(false);
		expect(anonPiVersionMismatch('0.26.0', undefined)).toBe(false);
		expect(anonPiVersionMismatch('', '0.26.0')).toBe(false);
		expect(anonPiVersionMismatch(undefined, undefined)).toBe(false);
	});
});

describe('resolveInitProjectsDefault (hardened re-run must not keep a leaking stored root)', () => {
	const loginHome = '/home/wighawag';
	const builtin = '/home/anon/.anon-pi/projects';

	it('no stored value: default is the builtin, not keepable', () => {
		expect(
			resolveInitProjectsDefault({builtin, loginHome, hardened: true}),
		).toEqual({
			keepCurrent: false,
			shown: builtin,
			droppedLeakingCurrent: false,
		});
	});

	it('HARDENED + stored value under login home: DROP it, default to builtin', () => {
		// the reported bug: `current: /home/wighawag/anon` was shown as the default
		// and Enter kept it; it must be dropped and the anon-tree builtin shown.
		expect(
			resolveInitProjectsDefault({
				currentResolved: '/home/wighawag/anon',
				builtin,
				loginHome,
				hardened: true,
			}),
		).toEqual({
			keepCurrent: false,
			shown: builtin,
			droppedLeakingCurrent: true,
		});
	});

	it('HARDENED + stored value already under the anon tree: KEEP it', () => {
		expect(
			resolveInitProjectsDefault({
				currentResolved: '/home/anon/work',
				builtin,
				loginHome,
				hardened: true,
			}),
		).toEqual({
			keepCurrent: true,
			shown: '/home/anon/work',
			droppedLeakingCurrent: false,
		});
	});

	it('NON-hardened: a login-home stored value is fine and KEPT (no leak concept)', () => {
		expect(
			resolveInitProjectsDefault({
				currentResolved: '/home/wighawag/anon',
				builtin: '/home/wighawag/.anon-pi/projects',
				loginHome,
				hardened: false,
			}),
		).toEqual({
			keepCurrent: true,
			shown: '/home/wighawag/anon',
			droppedLeakingCurrent: false,
		});
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

describe('anonPiVersion', () => {
	it('reads a semver-ish version string from the package.json', () => {
		const v = anonPiVersion();
		expect(typeof v).toBe('string');
		expect(v).toMatch(/^\d+\.\d+\.\d+/);
	});
});

describe('expandTilde', () => {
	it('expands a leading ~ / ~/ to $HOME', () => {
		expect(expandTilde('~', '/home/u')).toBe('/home/u');
		expect(expandTilde('~/dev/anon', '/home/u')).toBe('/home/u/dev/anon');
	});
	it('leaves absolute + relative + mid-string ~ alone', () => {
		expect(expandTilde('/abs/x', '/home/u')).toBe('/abs/x');
		expect(expandTilde('rel/x', '/home/u')).toBe('rel/x');
		expect(expandTilde('a/~/b', '/home/u')).toBe('a/~/b'); // mid ~ not touched
		expect(expandTilde('~user/x', '/home/u')).toBe('~user/x'); // ~user not expanded
	});
});

describe('resolveNetcageGraphroot', () => {
	it('defaults to the netcage /var/tmp store', () => {
		expect(resolveNetcageGraphroot({})).toBe(NETCAGE_DEFAULT_GRAPHROOT);
		expect(NETCAGE_DEFAULT_GRAPHROOT).toBe('/var/tmp/netcage-storage');
	});
	it('honours the NETCAGE_GRAPHROOT override', () => {
		expect(resolveNetcageGraphroot({NETCAGE_GRAPHROOT: '/scratch/s'})).toBe(
			'/scratch/s',
		);
		// blank is ignored (falls back to default)
		expect(resolveNetcageGraphroot({NETCAGE_GRAPHROOT: '   '})).toBe(
			NETCAGE_DEFAULT_GRAPHROOT,
		);
	});
});

describe('netcage detect-proxy reuse (findings mapping)', () => {
	const raw = {
		schemaVersion: 1,
		candidates: [
			{
				port: 9050,
				open: true,
				socks5: true,
				processHint: 'a `tor` process is running',
			},
			{
				port: 9150,
				open: false,
				socks5: false,
				processHint: 'a `tor` process is running',
			},
			{port: 1080, open: true, socks5: false},
		],
		exitIP: '45.84.107.17',
	};

	it('maps candidates to ProxyFinding[] with handshake verdicts + port hints', () => {
		const f = findingsFromNetcageDetect(raw);
		expect(f.map((x) => x.port)).toEqual([9050, 9150, 1080]);
		expect(f[0]).toMatchObject({
			host: '127.0.0.1',
			open: true,
			handshake: {socks5: true},
		});
		// a closed port has no handshake; an open-but-not-socks5 port is flagged
		expect(f[1].handshake).toBeUndefined();
		expect(f[2].handshake).toMatchObject({socks5: false});
		// structural port hints come from DEFAULT_SOCKS_PROBE_PORTS by port
		expect(f[0].portHint).toBeTruthy();
	});

	it('does NOT copy the per-candidate processHint onto each finding', () => {
		const f = findingsFromNetcageDetect(raw);
		for (const x of f) expect(x.processHint).toBeUndefined();
	});

	it('surfaces the host-wide process note ONCE', () => {
		expect(processNoteFromNetcageDetect(raw)).toBe(
			'a `tor` process is running',
		);
		expect(
			processNoteFromNetcageDetect({candidates: [{port: 1}]}),
		).toBeUndefined();
	});

	it('tolerates missing/garbage input (returns [])', () => {
		expect(findingsFromNetcageDetect(undefined)).toEqual([]);
		expect(findingsFromNetcageDetect({})).toEqual([]);
		expect(
			findingsFromNetcageDetect({candidates: [{}, {port: 'x' as never}]}),
		).toEqual([]);
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

describe('resumeSessionId (the id a RESUME launch selects)', () => {
	it('returns the token after a resume flag', () => {
		expect(resumeSessionId(['--session', '019f2cca'])).toBe('019f2cca');
		expect(resumeSessionId(['--session-id', 'abc'])).toBe('abc');
		expect(resumeSessionId(['--resume', 'id-1'])).toBe('id-1');
		expect(resumeSessionId(['-r', 'id-2'])).toBe('id-2');
	});

	it('finds the id even when the resume flag is not first', () => {
		expect(resumeSessionId(['--model', 'x', '--session', 'the-id'])).toBe(
			'the-id',
		);
	});

	it('is undefined for a bare resume flag (no id / a picker)', () => {
		expect(resumeSessionId(['--resume'])).toBeUndefined();
		expect(resumeSessionId(['--session', '--model'])).toBeUndefined();
	});

	it('is undefined with no resume flag, or no args', () => {
		expect(resumeSessionId(['--list-models'])).toBeUndefined();
		expect(resumeSessionId([])).toBeUndefined();
		expect(resumeSessionId(undefined)).toBeUndefined();
	});
});

describe('sessionHeaderCwd (cwd from a session file header line)', () => {
	it('reads cwd from a valid session header', () => {
		const line = JSON.stringify({
			type: 'session',
			version: 3,
			id: '019f2cca',
			cwd: '/projects/test',
		});
		expect(sessionHeaderCwd(line)).toBe('/projects/test');
	});

	it('is undefined for a non-session record, missing/empty cwd, or bad JSON', () => {
		expect(
			sessionHeaderCwd(JSON.stringify({type: 'message', cwd: '/x'})),
		).toBeUndefined();
		expect(
			sessionHeaderCwd(JSON.stringify({type: 'session', id: 'a'})),
		).toBeUndefined();
		expect(
			sessionHeaderCwd(JSON.stringify({type: 'session', cwd: ''})),
		).toBeUndefined();
		expect(sessionHeaderCwd('not json')).toBeUndefined();
		expect(sessionHeaderCwd('')).toBeUndefined();
	});
});
