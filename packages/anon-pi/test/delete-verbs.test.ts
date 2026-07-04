// The PURE affected-path resolvers for the destructive cleanup verbs
// (`--delete-home [<machine>]` / `--delete-project <project>`). Pure (no fs, no
// spawn): env + injected listings in -> the exact host paths a delete would
// remove out. The CLI wires these to the real filesystem + the confirm/`--yes`/
// non-TTY discipline (covered by cli-delete.test.ts).
//
// Isolated against a temp anon-pi home (injected via AnonPiEnv.anonPiHome): no
// real ~/.anon-pi is read or written.
import {describe, it, expect} from 'vitest';
import {
	AnonPiError,
	machineHomeDir,
	machineProjectSessionDir,
	machineSessionsDir,
	projectHostDir,
	projectSessionSlug,
	resolveDeleteHome,
	resolveDeleteProject,
	type AnonPiEnv,
} from '../src/index.js';

// A temp anon-pi home, injected: nothing touches the real ~/.anon-pi.
const env: AnonPiEnv = {
	home: '/home/u',
	anonPiHome: '/tmp/anon-pi-home',
};

describe('machine sessions-dir resolvers (host paths under a machine home)', () => {
	it('machineSessionsDir is <machineHome>/.pi/agent/sessions', () => {
		expect(machineSessionsDir(env, 'recon')).toBe(
			'/tmp/anon-pi-home/machines/recon/home/.pi/agent/sessions',
		);
	});

	it('machineProjectSessionDir is the project slug dir under that sessions dir', () => {
		expect(machineProjectSessionDir(env, 'recon', 'alpha')).toBe(
			`/tmp/anon-pi-home/machines/recon/home/.pi/agent/sessions/${projectSessionSlug(
				'alpha',
			)}`,
		);
	});

	it('machineProjectSessionDir validates the project name (rejects traversal)', () => {
		expect(() => machineProjectSessionDir(env, 'recon', '../escape')).toThrow(
			AnonPiError,
		);
	});
});

describe('resolveDeleteHome — the machine-home delete plan', () => {
	it('targets ONLY the machine home dir (machine.json / image pin kept)', () => {
		const plan = resolveDeleteHome(env, 'recon');
		expect(plan.machine).toBe('recon');
		expect(plan.home).toBe(machineHomeDir(env, 'recon'));
		// It does NOT target the whole machine dir (machine.json survives so the
		// machine can be relaunched to reseed a fresh home).
		expect(plan.home).toContain('/machines/recon/home');
		expect(plan.home.endsWith('/machines/recon')).toBe(false);
	});

	it('validates the machine name (rejects traversal / separators)', () => {
		expect(() => resolveDeleteHome(env, 'a/b')).toThrow(AnonPiError);
		expect(() => resolveDeleteHome(env, '..')).toThrow(AnonPiError);
	});
});

describe('resolveDeleteProject — the project files + per-machine sessions plan', () => {
	const projectsRoot = '/tmp/anon-pi-home/projects';

	it('targets the project folder AND every machine home session dir for its slug', () => {
		const plan = resolveDeleteProject({
			env,
			project: 'alpha',
			projectsRoot,
			machines: ['recon', 'stable'],
		});
		expect(plan.project).toBe('alpha');
		expect(plan.folder).toBe(projectHostDir(projectsRoot, 'alpha'));
		// one session dir per machine, keyed by the machine-invariant slug.
		expect(plan.sessions).toEqual([
			machineProjectSessionDir(env, 'recon', 'alpha'),
			machineProjectSessionDir(env, 'stable', 'alpha'),
		]);
	});

	it('with no machines, targets only the project folder (no sessions)', () => {
		const plan = resolveDeleteProject({
			env,
			project: 'alpha',
			projectsRoot,
			machines: [],
		});
		expect(plan.folder).toBe(projectHostDir(projectsRoot, 'alpha'));
		expect(plan.sessions).toEqual([]);
	});

	it('honours the resolved projects root (a --mount/config override)', () => {
		const plan = resolveDeleteProject({
			env,
			project: 'alpha',
			projectsRoot: '/host/dev',
			machines: ['recon'],
		});
		expect(plan.folder).toBe('/host/dev/alpha');
	});

	it('validates the project name (rejects traversal), covering folder + sessions', () => {
		expect(() =>
			resolveDeleteProject({
				env,
				project: '../escape',
				projectsRoot,
				machines: ['recon'],
			}),
		).toThrow(AnonPiError);
	});
});
