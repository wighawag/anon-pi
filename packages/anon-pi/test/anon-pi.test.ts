import {describe, it, expect} from 'vitest';
import {
	AnonPiError,
	buildRunPlan,
	CONTAINER_SEED_DIR,
	envFromProcess,
	hostPortKey,
	pickProviderForLlm,
	resolveAnonPiHome,
	resolveConfigSeed,
	resolveSourceModelsPath,
	type AnonPiEnv,
	type PiModelsFile,
} from '../src/index.js';

const base: AnonPiEnv = {
	home: '/home/u',
	image: 'my/pi:tag',
	llmDirect: '192.168.1.150:8080',
	proxy: 'socks5h://127.0.0.1:9050',
};

const seedPresent = () => true;
const seedAbsent = () => false;

describe('path resolution', () => {
	it('defaults the anon-pi home to ~/.config/anon-pi', () => {
		expect(resolveAnonPiHome(base)).toBe('/home/u/.config/anon-pi');
	});

	it('honours XDG_CONFIG_HOME for the home', () => {
		expect(resolveAnonPiHome({...base, xdgConfigHome: '/cfg'})).toBe(
			'/cfg/anon-pi',
		);
	});

	it('honours ANON_PI_HOME override', () => {
		expect(resolveAnonPiHome({...base, anonPiHome: '/opt/ap'})).toBe('/opt/ap');
	});

	it('defaults the seed to <home>/agent', () => {
		expect(resolveConfigSeed(base)).toBe('/home/u/.config/anon-pi/agent');
	});

	it('honours ANON_PI_CONFIG seed override', () => {
		expect(resolveConfigSeed({...base, configSeed: '/seed'})).toBe('/seed');
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
		expect(() => buildRunPlan({...base, image: ''}, '/w', seedPresent)).toThrow(
			/ANON_PI_IMAGE/,
		);
	});

	it('throws AnonPiError when ANON_PI_LLM is missing', () => {
		expect(() =>
			buildRunPlan({...base, llmDirect: ''}, '/w', seedPresent),
		).toThrow(/ANON_PI_LLM/);
	});

	it('requires ANON_PI_PROXY (no default: the proxy is what anonymizes)', () => {
		expect(() => buildRunPlan({...base, proxy: ''}, '/w', seedPresent)).toThrow(
			/ANON_PI_PROXY/,
		);
		expect(() =>
			buildRunPlan({...base, proxy: undefined}, '/w', seedPresent),
		).toThrow(/never guessed|no default/i);
	});

	it('missing-image error is copy-pasteable and mentions both Dockerfiles', () => {
		let msg = '';
		try {
			buildRunPlan(
				{
					...base,
					image: '',
					dockerfilePath: '/pkg/Dockerfile.pi',
					webveilDockerfilePath: '/pkg/examples/Dockerfile.pi-webveil',
				},
				'/w',
				seedPresent,
			);
		} catch (e) {
			msg = (e as Error).message;
		}
		for (const line of msg.split('\n')) {
			if (line.startsWith('podman ') || line.startsWith('export ')) continue;
			expect(/^\s+(podman|export)\b/.test(line)).toBe(false);
		}
		expect(msg).toContain('podman build');
		// both the simple image and the fuller webveil example are offered
		expect(msg).toContain('/pkg/Dockerfile.pi');
		expect(msg).toContain('/pkg/examples/Dockerfile.pi-webveil');
		expect(msg).not.toContain("<<'EOF'");
	});
});

describe('buildRunPlan missing seed models.json', () => {
	it('throws naming the models.json path and pointing at `anon-pi import`', () => {
		expect(() => buildRunPlan(base, '/work/recon', seedAbsent)).toThrow(
			AnonPiError,
		);
		try {
			buildRunPlan(base, '/work/recon', seedAbsent);
		} catch (e) {
			const msg = (e as Error).message;
			expect(msg).toContain('/home/u/.config/anon-pi/agent/models.json');
			expect(msg).toContain('anon-pi import');
		}
	});

	it('checks the models.json path (not the dir) for existence', () => {
		let checked = '';
		buildRunPlan(base, '/work/recon', (p) => {
			checked = p;
			return true;
		});
		expect(checked).toBe('/home/u/.config/anon-pi/agent/models.json');
	});
});

describe('buildRunPlan netcage argv', () => {
	const plan = buildRunPlan(base, '/work/recon', seedPresent);

	it('starts with run + the configured proxy', () => {
		expect(plan.netcageArgs.slice(0, 3)).toEqual([
			'run',
			'--proxy',
			'socks5h://127.0.0.1:9050',
		]);
	});

	it('uses the ANON_PI_PROXY value verbatim', () => {
		const p = buildRunPlan(
			{...base, proxy: 'socks5h://10.0.0.5:9050'},
			'/w',
			seedPresent,
		);
		expect(p.netcageArgs[2]).toBe('socks5h://10.0.0.5:9050');
	});

	it('opens exactly one direct hole for the local model', () => {
		const i = plan.netcageArgs.indexOf('--allow-direct');
		expect(i).toBeGreaterThan(-1);
		expect(plan.netcageArgs[i + 1]).toBe('192.168.1.150:8080');
		expect(plan.netcageArgs.filter((a) => a === '--allow-direct')).toHaveLength(
			1,
		);
	});

	it('normalizes a URL-form ANON_PI_LLM for --allow-direct (strips scheme/path)', () => {
		// netcage's --allow-direct rejects a scheme; a user naturally sets a URL.
		for (const llm of [
			'http://192.168.1.150:8080',
			'http://192.168.1.150:8080/v1',
			'192.168.1.150:8080',
		]) {
			const p = buildRunPlan({...base, llmDirect: llm}, '/w', seedPresent);
			const i = p.netcageArgs.indexOf('--allow-direct');
			expect(p.netcageArgs[i + 1]).toBe('192.168.1.150:8080');
		}
	});

	it('is interactive', () => {
		expect(plan.netcageArgs).toContain('-it');
	});

	it('mounts the workdir (target-less -v, netcage defaults it to /work)', () => {
		expect(plan.netcageArgs).toContain('/work/recon');
	});

	it('mounts the seed READ-ONLY at the neutral seed dir (not as the agent dir)', () => {
		expect(plan.netcageArgs).toContain(
			`${plan.configSeed}:${CONTAINER_SEED_DIR}:ro`,
		);
		// It must NOT set PI_CODING_AGENT_DIR or mount over the agent dir, else it
		// would shadow the image's extensions.
		expect(plan.netcageArgs.join(' ')).not.toContain('PI_CODING_AGENT_DIR');
	});

	it('runs pi via a copy-then-exec shell step so the image config survives', () => {
		// ... IMAGE sh -c '<copy>; exec pi'
		const i = plan.netcageArgs.indexOf('my/pi:tag');
		expect(i).toBeGreaterThan(-1);
		expect(plan.netcageArgs[i + 1]).toBe('sh');
		expect(plan.netcageArgs[i + 2]).toBe('-c');
		const cmd = plan.netcageArgs[i + 3];
		expect(cmd).toContain('cp /anon-pi-seed/models.json');
		expect(cmd).toContain('$HOME/.pi/agent');
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
		});
	});
});
