import {describe, it, expect} from 'vitest';
import {
	AnonPiError,
	buildRunPlan,
	CONTAINER_AGENT_DIR,
	envFromProcess,
	hostPortKey,
	pathSlug,
	pickProviderForLlm,
	resolveAnonPiHome,
	resolveConfigSeed,
	resolveSourceModelsPath,
	stateAgentDir,
	type AnonPiEnv,
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

	it('uses an ephemeral throwaway home when env.ephemeral', () => {
		const p = buildRunPlan(
			{...base, ephemeral: true},
			'/w',
			seedPresent,
			statePresent, // ignored for ephemeral
			'/tmp/throwaway/agent',
		);
		expect(p.stateDir).toBe('/tmp/throwaway/agent');
		expect(p.fresh).toBe(true); // ephemeral is always fresh
		expect(p.netcageArgs).toContain(
			`/tmp/throwaway/agent:${CONTAINER_AGENT_DIR}`,
		);
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
		});
	});

	it('ephemeral is false unless ANON_PI_EPHEMERAL is truthy', () => {
		expect(envFromProcess({}).ephemeral).toBe(false);
		expect(envFromProcess({ANON_PI_EPHEMERAL: 'yes'}).ephemeral).toBe(true);
		expect(envFromProcess({ANON_PI_EPHEMERAL: '0'}).ephemeral).toBe(false);
	});
});
