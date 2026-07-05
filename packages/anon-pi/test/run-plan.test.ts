// Per-machine RunPlan resolver: composes the netcage argv for every launch mode
// (menu / pi <project> / shell [project] / --mount <parent> [project], plus the
// `.` root token), preserving the forced-egress invariant on every path.
//
// PURE (no spawn/fs). Every path is derived from injected inputs; no real
// ~/.anon-pi is read or written.
import {describe, it, expect} from 'vitest';
import {
	AnonPiError,
	CONTAINER_AGENT_DIR,
	CONTAINER_HOME_ROOT,
	CONTAINER_MOUNT_ROOT,
	CONTAINER_PROJECTS_ROOT,
	resolveRunPlan,
	type LaunchIntent,
	type Machine,
} from '../src/index.js';

const machine: Machine = {
	name: 'recon',
	home: '/tmp/anon-pi-home/machines/recon/home',
	image: 'my/pi:tag',
};

const projectsRoot = '/tmp/anon-pi-home/projects';

// A base pi <project> intent with the forced-egress inputs supplied.
const baseIntent = (over: Partial<LaunchIntent> = {}): LaunchIntent => ({
	machine,
	mode: 'pi',
	projectsRoot,
	project: 'recon',
	proxy: 'socks5h://127.0.0.1:9050',
	llmDirect: '192.168.1.150:8080',
	...over,
});

// homeFresh default: home is FRESH (seed will run in the container).
const homeFresh = () => true;
const homeSeeded = () => false;

// resolve a plan and NARROW to the launch shape (throws if it is the menu marker)
function launch(over: Partial<LaunchIntent> = {}, fresh = homeFresh) {
	const p = resolveRunPlan(baseIntent(over), fresh);
	if (p.kind !== 'launch')
		throw new Error(`expected a launch plan, got ${p.kind}`);
	return p;
}

describe('resolveRunPlan — modes', () => {
	it('menu (bare) yields a menu-marker plan with NO netcage argv', () => {
		const p = resolveRunPlan(
			baseIntent({mode: 'menu', project: undefined}),
			homeFresh,
		);
		expect(p.kind).toBe('menu');
		expect('netcageArgs' in p).toBe(false);
		if (p.kind === 'menu') expect(p.machine.name).toBe('recon');
	});

	it('pi <project> cwds into /projects/<project>', () => {
		const p = launch({mode: 'pi', project: 'recon'});
		expect(p.cwd).toBe(`${CONTAINER_PROJECTS_ROOT}/recon`);
		const i = p.netcageArgs.indexOf('-w');
		expect(p.netcageArgs[i + 1]).toBe(`${CONTAINER_PROJECTS_ROOT}/recon`);
	});

	it('pi . (root token) cwds into /projects', () => {
		const p = launch({mode: 'pi', project: '.'});
		expect(p.cwd).toBe(CONTAINER_PROJECTS_ROOT);
	});

	it('pi <project> <args> forwards the extra args to pi (as $@ argv, seeded)', () => {
		const p = launch({
			mode: 'pi',
			project: 'recon',
			piArgs: ['-p', 'do a thing'],
		});
		const i = p.netcageArgs.indexOf(machine.image);
		// after the image: sh -c '<seed> && exec pi "$@"' pi <args...>. The args are
		// the shell's positional argv ($@), so they are forwarded verbatim (no re-quote).
		expect(p.netcageArgs.slice(i + 1, i + 3)).toEqual(['sh', '-c']);
		const cmd = p.netcageArgs[i + 3];
		expect(cmd).toContain('exec pi "$@"');
		// the forwarded args are the trailing argv, after the `pi` $0 placeholder
		expect(p.netcageArgs.slice(i + 4)).toEqual(['pi', '-p', 'do a thing']);
	});

	it('pi <project> with NO forwarded args seeds then execs pi', () => {
		const p = launch({mode: 'pi', project: 'recon'});
		const i = p.netcageArgs.indexOf(machine.image);
		expect(p.netcageArgs.slice(i + 1, i + 3)).toEqual(['sh', '-c']);
		expect(p.netcageArgs[i + 3]).toContain('exec pi');
		// no forwarded-arg argv trailing the command
		expect(p.netcageArgs.length).toBe(i + 4);
	});

	it('--shell with no project runs bash at /projects (the projects root)', () => {
		// A bare shell defaults to the projects root (the project-hopper landing),
		// NOT the machine home /root; `--shell .` is the same cwd (a synonym).
		const p = launch({mode: 'shell', project: undefined});
		expect(p.cwd).toBe(CONTAINER_PROJECTS_ROOT);
		expect(p.cwd).not.toBe(CONTAINER_HOME_ROOT);
		const i = p.netcageArgs.indexOf(machine.image);
		expect(p.netcageArgs.slice(i + 1, i + 3)).toEqual(['sh', '-c']);
		expect(p.netcageArgs[i + 3]).toContain('exec bash');
		expect(p.netcageArgs[i + 3]).not.toContain('exec pi');
	});

	it('--shell <project> runs bash cwd /projects/<project>', () => {
		const p = launch({mode: 'shell', project: 'recon'});
		expect(p.cwd).toBe(`${CONTAINER_PROJECTS_ROOT}/recon`);
		const i = p.netcageArgs.indexOf(machine.image);
		expect(p.netcageArgs[i + 3]).toContain('exec bash');
	});

	it('--shell . runs bash cwd /projects (the root token, same as bare --shell)', () => {
		const p = launch({mode: 'shell', project: '.'});
		expect(p.cwd).toBe(CONTAINER_PROJECTS_ROOT);
		// bare --shell and `--shell .` land at the SAME cwd (synonyms).
		expect(p.cwd).toBe(launch({mode: 'shell', project: undefined}).cwd);
	});

	it('interactive modes (pi / shell) allocate a TTY (-it)', () => {
		expect(launch({mode: 'pi', project: 'recon'}).netcageArgs).toContain('-it');
		expect(launch({mode: 'shell', project: undefined}).netcageArgs).toContain(
			'-it',
		);
	});

	it('a HEADLESS pi run (forwarded args) omits -it (works without a TTY)', () => {
		const p = launch({mode: 'pi', project: 'recon', piArgs: ['-p', 'x']});
		expect(p.netcageArgs).not.toContain('-it');
		// but the forced-egress flags are STILL present (see the invariant suite)
		expect(p.netcageArgs).toContain('--proxy');
		expect(p.netcageArgs).toContain('--allow-direct');
	});

	it('a pi session-resume launch (no project) cwds at the projects ROOT, INTERACTIVE', () => {
		// `anon-pi --session <id>`: pi mode, no project, --session forwarded. pi
		// switches to the session's own cwd, so anon-pi starts at /projects (not
		// /root, which is the shell-at-home case) and keeps -it (interactive).
		const p = launch({
			project: undefined,
			piArgs: ['--session', '019f2bde-fd47'],
		});
		expect(p.cwd).toBe(CONTAINER_PROJECTS_ROOT); // /projects, the root
		expect(p.cwd).not.toBe(CONTAINER_HOME_ROOT); // NOT /root
		expect(p.netcageArgs).toContain('-it'); // interactive
		// the session flag is forwarded to pi
		const tail = p.netcageArgs.slice(p.netcageArgs.indexOf('pi'));
		expect(tail).toEqual(['pi', '--session', '019f2bde-fd47']);
	});

	it('a shell with no project sits at the projects root (NOT the machine home)', () => {
		const p = launch({mode: 'shell', project: undefined});
		expect(p.cwd).toBe(CONTAINER_PROJECTS_ROOT);
		expect(p.cwd).not.toBe(CONTAINER_HOME_ROOT);
	});

	it('a --mount shell with no project sits at the /work root (not /projects, not /root)', () => {
		const p = launch({
			mode: 'shell',
			mountParent: '/host/dev',
			project: undefined,
		});
		expect(p.cwd).toBe(CONTAINER_MOUNT_ROOT);
	});
});

describe('resolveRunPlan — RESUME sessionCwd override (no-project cd)', () => {
	// A RESUME-family launch with NO project: the CLI resolves the session's
	// recorded cwd and passes it as intent.sessionCwd, which OVERRIDES the default
	// no-project cwd (the projects root) so pi resumes in place (no fork prompt).
	it('cds into the session cwd for a no-project --session launch', () => {
		const p = launch({
			mode: 'pi',
			project: undefined,
			piArgs: ['--session', '019f2cca'],
			sessionCwd: `${CONTAINER_PROJECTS_ROOT}/test`,
		});
		expect(p.cwd).toBe(`${CONTAINER_PROJECTS_ROOT}/test`);
		const i = p.netcageArgs.indexOf('-w');
		expect(p.netcageArgs[i + 1]).toBe(`${CONTAINER_PROJECTS_ROOT}/test`);
		// the session flag is still forwarded verbatim
		const tail = p.netcageArgs.slice(p.netcageArgs.indexOf('pi'));
		expect(tail).toEqual(['pi', '--session', '019f2cca']);
	});

	it('an EXPLICIT project WINS over sessionCwd (user trusted; pi guards)', () => {
		const p = launch({
			mode: 'pi',
			project: 'someproj',
			piArgs: ['--session', 'x'],
			sessionCwd: `${CONTAINER_PROJECTS_ROOT}/test`,
		});
		expect(p.cwd).toBe(`${CONTAINER_PROJECTS_ROOT}/someproj`);
	});

	it('an unresolved session (no sessionCwd) stays at the projects root', () => {
		const p = launch({
			mode: 'pi',
			project: undefined,
			piArgs: ['--session', 'unknown'],
		});
		expect(p.cwd).toBe(CONTAINER_PROJECTS_ROOT);
	});

	it('an empty sessionCwd is ignored (falls back to the projects root)', () => {
		const p = launch({
			mode: 'pi',
			project: undefined,
			piArgs: ['--resume', 'id'],
			sessionCwd: '',
		});
		expect(p.cwd).toBe(CONTAINER_PROJECTS_ROOT);
	});

	it('a --mount session cwd is honoured verbatim (/work/<p>)', () => {
		const p = launch({
			mode: 'pi',
			project: undefined,
			mountParent: '/host/parent',
			piArgs: ['--session', 'x'],
			sessionCwd: `${CONTAINER_MOUNT_ROOT}/sub`,
		});
		expect(p.cwd).toBe(`${CONTAINER_MOUNT_ROOT}/sub`);
	});
});

describe('resolveRunPlan — the two invariant mounts (always)', () => {
	function mountsOf(args: string[]): string[] {
		const out: string[] = [];
		for (let i = 0; i < args.length; i++) {
			if (args[i] === '-v') out.push(args[i + 1]);
		}
		return out;
	}

	it('ALWAYS mounts <home>:/root and <projects-root>:/projects', () => {
		for (const intent of [
			baseIntent({mode: 'pi', project: 'recon'}),
			baseIntent({mode: 'shell', project: undefined}),
			baseIntent({mode: 'pi', project: '.'}),
		]) {
			const p = resolveRunPlan(intent, homeFresh);
			if (p.kind !== 'launch') throw new Error('expected launch');
			const mounts = mountsOf(p.netcageArgs);
			expect(mounts).toContain(`${machine.home}:${CONTAINER_HOME_ROOT}`);
			expect(mounts).toContain(`${projectsRoot}:${CONTAINER_PROJECTS_ROOT}`);
		}
	});

	it('the machine home mount is present on EVERY path (incl. --mount)', () => {
		for (const intent of [
			baseIntent({mode: 'pi', project: 'recon'}),
			baseIntent({mode: 'pi', project: 'recon'}),
			baseIntent({mode: 'shell', mountParent: '/host/dev', project: 'sub'}),
		]) {
			const p = resolveRunPlan(intent, homeFresh);
			if (p.kind !== 'launch') throw new Error('expected launch');
			expect(mountsOf(p.netcageArgs)).toContain(
				`${machine.home}:${CONTAINER_HOME_ROOT}`,
			);
		}
	});

	it('--mount adds EXACTLY the one parent mount at /work and nothing else changes', () => {
		const plain = launch({mode: 'pi', project: 'recon'});
		const mounted = launch({
			mode: 'pi',
			project: 'recon',
			mountParent: '/host/dev',
		});
		const plainMounts = mountsOf(plain.netcageArgs);
		const mountedMounts = mountsOf(mounted.netcageArgs);
		// the two invariant mounts are still there, unchanged
		expect(mountedMounts).toContain(`${machine.home}:${CONTAINER_HOME_ROOT}`);
		expect(mountedMounts).toContain(
			`${projectsRoot}:${CONTAINER_PROJECTS_ROOT}`,
		);
		// EXACTLY one added mount: the parent at /work
		const added = mountedMounts.filter((m) => !plainMounts.includes(m));
		expect(added).toEqual([`/host/dev:${CONTAINER_MOUNT_ROOT}`]);
	});

	it('--mount re-roots cwd into /work[/<project>]', () => {
		expect(
			launch({mode: 'pi', project: 'sub', mountParent: '/host/dev'}).cwd,
		).toBe(`${CONTAINER_MOUNT_ROOT}/sub`);
		expect(
			launch({mode: 'pi', project: '.', mountParent: '/host/dev'}).cwd,
		).toBe(CONTAINER_MOUNT_ROOT);
	});
});

describe('resolveRunPlan — throwaway always (--rm on every launch)', () => {
	it('--rm is present on EVERY launch (throwaway is the only behaviour)', () => {
		for (const over of [
			{mode: 'pi' as const, project: 'recon'},
			{mode: 'shell' as const, project: undefined},
			{mode: 'pi' as const, project: '.'},
			{mode: 'pi' as const, project: 'sub', mountParent: '/host/dev'},
		]) {
			expect(launch(over).netcageArgs).toContain('--rm');
		}
	});

	it('the machine home mount survives (throwaway loses only container scratch)', () => {
		const p = launch();
		expect(p.netcageArgs.join(' ')).toContain(
			`${machine.home}:${CONTAINER_HOME_ROOT}`,
		);
	});
});

describe('resolveRunPlan — seed-if-fresh (per machine home)', () => {
	it('reports fresh=true when the machine home is fresh, false when seeded', () => {
		expect(launch({}, homeFresh).fresh).toBe(true);
		expect(launch({}, homeSeeded).fresh).toBe(false);
	});

	it('runs the marker-guarded seed then exec pi (reusing containerRunCmd shape)', () => {
		const p = launch({mode: 'pi', project: 'recon'});
		const cmd = p.netcageArgs.join(' ');
		// seed only if the marker is absent, seeded into /root/.pi/agent, then pi
		expect(cmd).toContain('.anon-pi-seed');
		expect(cmd).toContain('/opt/anon-pi-seed/agent'); // image-staged pi defaults
		expect(cmd).toContain(CONTAINER_AGENT_DIR); // /root/.pi/agent
		expect(cmd).toContain('exec pi');
	});

	it('mounts the generated models.json read-only for the seed when supplied', () => {
		const p = launch({
			modelsSeed: '/tmp/anon-pi-home/machines/recon/models.json',
		});
		expect(p.netcageArgs).toContain(
			'/tmp/anon-pi-home/machines/recon/models.json:/anon-pi-seed/models.json:ro',
		);
	});

	it('omits the models.json mount when no seed is supplied', () => {
		const p = launch({modelsSeed: undefined});
		expect(
			p.netcageArgs.some((a) => a.endsWith(':/anon-pi-seed/models.json:ro')),
		).toBe(false);
	});

	it('runs bash (NOT pi) under --shell, but still seeds if fresh', () => {
		const p = launch({mode: 'shell', project: undefined});
		const i = p.netcageArgs.indexOf(machine.image);
		const cmd = p.netcageArgs[i + 3];
		expect(cmd).toContain('exec bash');
		expect(cmd).toContain('.anon-pi-seed'); // still marker-guarded seed
	});
});

describe('resolveRunPlan — forced egress (HARD invariant, EVERY mode)', () => {
	// every mode that composes a netcage argv must carry --proxy + exactly one
	// --allow-direct and nothing that could leak.
	const modes: Array<Partial<LaunchIntent>> = [
		{mode: 'pi', project: 'recon'},
		{mode: 'pi', project: '.'},
		{mode: 'pi', project: 'recon', piArgs: ['-p', 'x']},
		{mode: 'shell', project: undefined},
		{mode: 'shell', project: 'recon'},
		{mode: 'shell', project: '.'},
		{mode: 'pi', project: 'sub', mountParent: '/host/dev'},
		{mode: 'shell', mountParent: '/host/dev', project: undefined},
	];

	it('EVERY composed argv carries --proxy <p> and exactly one --allow-direct <llm>', () => {
		for (const over of modes) {
			const p = launch(over);
			const args = p.netcageArgs;
			const pi = args.indexOf('--proxy');
			expect(pi).toBeGreaterThan(-1);
			expect(args[pi + 1]).toBe('socks5h://127.0.0.1:9050');
			expect(args.filter((a) => a === '--allow-direct')).toHaveLength(1);
			const di = args.indexOf('--allow-direct');
			expect(args[di + 1]).toBe('192.168.1.150:8080');
		}
	});

	it('a plan can NEVER be produced without the proxy (fail-closed)', () => {
		expect(() => resolveRunPlan(baseIntent({proxy: ''}), homeFresh)).toThrow(
			AnonPiError,
		);
		expect(() => resolveRunPlan(baseIntent({proxy: '   '}), homeFresh)).toThrow(
			AnonPiError,
		);
		// even the menu marker refuses without a proxy (never a plan without it)
		expect(() =>
			resolveRunPlan(
				baseIntent({mode: 'menu', project: undefined, proxy: ''}),
				homeFresh,
			),
		).toThrow(AnonPiError);
	});

	it('requires the direct-hole llm (exactly one hole, never zero)', () => {
		expect(() =>
			resolveRunPlan(baseIntent({llmDirect: ''}), homeFresh),
		).toThrow(AnonPiError);
	});

	it('normalizes a URL-form llm for --allow-direct (strips scheme/path)', () => {
		for (const llm of [
			'http://192.168.1.150:8080',
			'http://192.168.1.150:8080/v1',
			'192.168.1.150:8080',
		]) {
			const args = launch({llmDirect: llm}).netcageArgs;
			const di = args.indexOf('--allow-direct');
			expect(args[di + 1]).toBe('192.168.1.150:8080');
		}
	});
});

describe('resolveRunPlan — required inputs (image)', () => {
	it('throws AnonPiError when the machine image is missing', () => {
		expect(() =>
			resolveRunPlan(baseIntent({machine: {...machine, image: ''}}), homeFresh),
		).toThrow(AnonPiError);
	});

	it('throws AnonPiError when the machine home is missing', () => {
		expect(() =>
			resolveRunPlan(baseIntent({machine: {...machine, home: ''}}), homeFresh),
		).toThrow(AnonPiError);
	});
});
