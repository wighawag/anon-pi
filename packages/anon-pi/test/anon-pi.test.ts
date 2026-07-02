import {describe, it, expect} from 'vitest';
import {
	AnonPiError,
	buildRunPlan,
	DEFAULT_CONTAINER_AGENT_DIR,
	envFromProcess,
	PI_AGENT_DIR_ENV,
	resolveAgentMount,
	resolveAnonPiHome,
	resolveConfigSeed,
	sessionAgentDir,
	sessionId,
	type AnonPiEnv,
} from '../src/index.js';

const base: AnonPiEnv = {
	home: '/home/u',
	image: 'my/pi:tag',
	llmDirect: '192.168.1.150:8080',
};

const seedAlways = () => true;
const sessionAbsent = () => false;
const sessionPresent = () => true;

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

describe('session identity keyed to the absolute workdir', () => {
	it('is stable for the same path', () => {
		expect(sessionId('/a/b')).toBe(sessionId('/a/b'));
	});

	it('differs for different paths', () => {
		expect(sessionId('/a/b')).not.toBe(sessionId('/a/c'));
	});

	it('is a 16-char hex slice', () => {
		expect(sessionId('/a/b')).toMatch(/^[0-9a-f]{16}$/);
	});

	it('places the session agent dir under <home>/sessions/<id>/agent', () => {
		const dir = sessionAgentDir(base, '/work/recon');
		expect(dir).toBe(
			`/home/u/.config/anon-pi/sessions/${sessionId('/work/recon')}/agent`,
		);
	});
});

describe('buildRunPlan required inputs', () => {
	it('throws AnonPiError when ANON_PI_IMAGE is missing', () => {
		expect(() =>
			buildRunPlan({...base, image: ''}, '/w', seedAlways, sessionAbsent),
		).toThrow(AnonPiError);
	});

	it('throws AnonPiError when ANON_PI_LLM is missing', () => {
		expect(() =>
			buildRunPlan({...base, llmDirect: ''}, '/w', seedAlways, sessionAbsent),
		).toThrow(AnonPiError);
	});

	it('error names the offending env var', () => {
		expect(() =>
			buildRunPlan({...base, image: ''}, '/w', seedAlways, sessionAbsent),
		).toThrow(/ANON_PI_IMAGE/);
		expect(() =>
			buildRunPlan({...base, llmDirect: ''}, '/w', seedAlways, sessionAbsent),
		).toThrow(/ANON_PI_LLM/);
	});
});

describe('buildRunPlan missing seed (never auto-populate)', () => {
	it('throws naming the seed path and telling the user to populate it', () => {
		const missingSeed = () => false;
		expect(() =>
			buildRunPlan(base, '/work/recon', missingSeed, sessionAbsent),
		).toThrow(AnonPiError);
		try {
			buildRunPlan(base, '/work/recon', missingSeed, sessionAbsent);
		} catch (e) {
			const msg = (e as Error).message;
			expect(msg).toContain('/home/u/.config/anon-pi/agent');
			expect(msg.toLowerCase()).toContain('never populates it');
			expect(msg).toContain('trust.json');
		}
	});
});

describe('buildRunPlan seed decision (reuse if present, seed if absent)', () => {
	it('needsSeed=true when the session dir is absent', () => {
		const plan = buildRunPlan(base, '/work/recon', seedAlways, sessionAbsent);
		expect(plan.needsSeed).toBe(true);
	});

	it('needsSeed=false when the session dir already exists (resume)', () => {
		const plan = buildRunPlan(base, '/work/recon', seedAlways, sessionPresent);
		expect(plan.needsSeed).toBe(false);
	});
});

describe('buildRunPlan tooljail argv', () => {
	const plan = buildRunPlan(base, '/work/recon', seedAlways, sessionAbsent);

	it('starts with run + the proxy default', () => {
		expect(plan.tooljailArgs.slice(0, 3)).toEqual([
			'run',
			'--proxy',
			'socks5h://127.0.0.1:9050',
		]);
	});

	it('honours ANON_PI_PROXY override', () => {
		const p = buildRunPlan(
			{...base, proxy: 'socks5h://10.0.0.5:9050'},
			'/w',
			seedAlways,
			sessionAbsent,
		);
		expect(p.tooljailArgs[2]).toBe('socks5h://10.0.0.5:9050');
	});

	it('opens exactly one direct hole for the local model', () => {
		const i = plan.tooljailArgs.indexOf('--allow-direct');
		expect(i).toBeGreaterThan(-1);
		expect(plan.tooljailArgs[i + 1]).toBe('192.168.1.150:8080');
		// exactly one --allow-direct
		expect(
			plan.tooljailArgs.filter((a) => a === '--allow-direct'),
		).toHaveLength(1);
	});

	it('is interactive', () => {
		expect(plan.tooljailArgs).toContain('-it');
	});

	it('mounts the workdir (target-less -v, tooljail defaults it to /work)', () => {
		expect(plan.tooljailArgs).toContain('/work/recon');
	});

	it('mounts the seeded session config at the default mount and points pi at it', () => {
		expect(plan.agentMount).toBe(DEFAULT_CONTAINER_AGENT_DIR);
		expect(plan.tooljailArgs).toContain(
			`${plan.sessionAgentDir}:${DEFAULT_CONTAINER_AGENT_DIR}`,
		);
		expect(plan.tooljailArgs).toContain(
			`${PI_AGENT_DIR_ENV}=${DEFAULT_CONTAINER_AGENT_DIR}`,
		);
	});

	it('ends with the image then the pi command', () => {
		expect(plan.tooljailArgs.slice(-2)).toEqual(['my/pi:tag', 'pi']);
	});

	it('does NOT mount the canonical seed into the container (it is read-only, copy-only)', () => {
		const mountsSeed = plan.tooljailArgs.some((a) =>
			a.startsWith(`${plan.configSeed}:`),
		);
		expect(mountsSeed).toBe(false);
	});
});

describe('agent-mount override (ANON_PI_AGENT_MOUNT, option 3)', () => {
	it('defaults to /opt/pi-agent', () => {
		expect(resolveAgentMount(base)).toBe('/opt/pi-agent');
		expect(resolveAgentMount(base)).toBe(DEFAULT_CONTAINER_AGENT_DIR);
	});

	it('honours an absolute override (e.g. a root image ~/.pi/agent)', () => {
		expect(resolveAgentMount({...base, agentMount: '/root/.pi/agent'})).toBe(
			'/root/.pi/agent',
		);
	});

	it('threads the override into BOTH the -v target and the env var, in lockstep', () => {
		const plan = buildRunPlan(
			{...base, agentMount: '/root/.pi/agent'},
			'/work/recon',
			seedAlways,
			sessionAbsent,
		);
		expect(plan.agentMount).toBe('/root/.pi/agent');
		expect(plan.tooljailArgs).toContain(
			`${plan.sessionAgentDir}:/root/.pi/agent`,
		);
		expect(plan.tooljailArgs).toContain(`${PI_AGENT_DIR_ENV}=/root/.pi/agent`);
	});

	it('rejects a ~-relative mount (podman does not expand ~)', () => {
		expect(() =>
			resolveAgentMount({...base, agentMount: '~/.pi/agent'}),
		).toThrow(AnonPiError);
		expect(() =>
			buildRunPlan(
				{...base, agentMount: '~/.pi/agent'},
				'/w',
				seedAlways,
				sessionAbsent,
			),
		).toThrow(/ABSOLUTE/);
	});

	it('rejects a relative mount', () => {
		expect(() => resolveAgentMount({...base, agentMount: 'pi-agent'})).toThrow(
			AnonPiError,
		);
	});

	it('treats an empty override as unset (falls back to default)', () => {
		expect(resolveAgentMount({...base, agentMount: ''})).toBe(
			DEFAULT_CONTAINER_AGENT_DIR,
		);
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
			ANON_PI_AGENT_MOUNT: '/root/.pi/agent',
		});
		expect(env).toMatchObject({
			home: '/home/z',
			image: 'img',
			llmDirect: '10.0.0.9:1234',
			proxy: 'socks5h://p:1',
			anonPiHome: '/ah',
			configSeed: '/seed',
			xdgConfigHome: '/xdg',
			agentMount: '/root/.pi/agent',
		});
	});
});
