// End-to-end dispatch for the destructive cleanup verbs `anon-pi --delete-home
// [<machine>]` and `anon-pi --delete-project <project>`: spawn the built CLI
// against a TEMP anon-pi home (ANON_PI_HOME) and assert each verb deletes
// EXACTLY the right paths and nothing else, honouring the confirm/`--yes`/
// non-TTY discipline. The pure affected-path resolution is covered by
// delete-verbs.test.ts; this covers only the thin I/O (confirm + `rm`).
//
// These verbs delete real dirs, so every test ISOLATES to a mkdtemp home and the
// suite also asserts the real ~/.anon-pi is never touched.
//
// Requires the package to be built (dist/cli.js); CI builds before test.
import {describe, it, expect} from 'vitest';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {homedir, tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {projectSessionSlug} from '../src/index.js';

const cli = join(
	dirname(fileURLToPath(import.meta.url)),
	'..',
	'dist',
	'cli.js',
);

// A non-tty stdin (spawnSync pipes stdin), so a prompt-needing path hits its
// non-TTY branch. `input` feeds a confirm answer where a path DOES read stdin.
function run(
	args: string[],
	opts: {home: string; input?: string; env?: Record<string, string>},
) {
	return spawnSync(process.execPath, [cli, ...args], {
		encoding: 'utf8',
		input: opts.input,
		env: {
			...process.env,
			ANON_PI_HOME: opts.home,
			...(opts.env ?? {}),
		},
	});
}

function tempHome(): string {
	return mkdtempSync(join(tmpdir(), 'anon-pi-home-'));
}

/** mkdir a file at <home>/<...segments> (creating parents) and return its path. */
function touch(...parts: string[]): string {
	const p = join(...parts);
	mkdirSync(dirname(p), {recursive: true});
	writeFileSync(p, 'x');
	return p;
}

/** The host session dir for <project> in machine <m>'s home. */
function sessionDir(home: string, machine: string, project: string): string {
	return join(
		home,
		'machines',
		machine,
		'home',
		'.pi',
		'agent',
		'sessions',
		projectSessionSlug(project),
	);
}

/**
 * A workspace with two machines (recon default + stable) and two projects
 * (alpha used on both, beta used only on recon), each with a marker file, plus a
 * config.json pinning the default machine. Returns the paths that matter.
 */
function seedWorkspace(home: string) {
	mkdirSync(home, {recursive: true});
	writeFileSync(
		join(home, 'config.json'),
		JSON.stringify({defaultMachine: 'recon'}),
	);
	// machine dirs + machine.json (the image pin) + a marker in each home.
	for (const m of ['recon', 'stable']) {
		touch(home, 'machines', m, 'machine.json');
		touch(home, 'machines', m, 'home', '.pi', 'agent', '.anon-pi-seed');
	}
	// project folders under the (default) projects root.
	const alphaFolder = join(home, 'projects', 'alpha');
	const betaFolder = join(home, 'projects', 'beta');
	touch(alphaFolder, 'file.txt');
	touch(betaFolder, 'file.txt');
	// sessions: alpha on recon + stable; beta on recon only.
	touch(sessionDir(home, 'recon', 'alpha'), 'session');
	touch(sessionDir(home, 'stable', 'alpha'), 'session');
	touch(sessionDir(home, 'recon', 'beta'), 'session');
	return {alphaFolder, betaFolder};
}

describe('--delete-home [<machine>]', () => {
	it('--yes deletes the named machine home, keeps its image pin + project files', () => {
		const home = tempHome();
		const {alphaFolder} = seedWorkspace(home);
		const stableHome = join(home, 'machines', 'stable', 'home');
		const stableJson = join(home, 'machines', 'stable', 'machine.json');

		const r = run(['--delete-home', 'stable', '--yes'], {home});
		expect(r.status).toBe(0);
		// the home is gone...
		expect(existsSync(stableHome)).toBe(false);
		// ...but the machine.json (image pin) survives, so it can reseed.
		expect(existsSync(stableJson)).toBe(true);
		// project files are untouched.
		expect(existsSync(join(alphaFolder, 'file.txt'))).toBe(true);
		// the OTHER machine home is untouched.
		expect(
			existsSync(join(home, 'machines', 'recon', 'home', '.pi', 'agent')),
		).toBe(true);
	});

	it('with no machine arg, deletes the DEFAULT machine home (config.defaultMachine)', () => {
		const home = tempHome();
		seedWorkspace(home);
		const reconHome = join(home, 'machines', 'recon', 'home');
		const r = run(['--delete-home', '--yes'], {home});
		expect(r.status).toBe(0);
		expect(existsSync(reconHome)).toBe(false);
		// stable (non-default) untouched.
		expect(existsSync(join(home, 'machines', 'stable', 'home'))).toBe(true);
	});

	it('non-TTY without --yes ABORTS and deletes nothing', () => {
		const home = tempHome();
		seedWorkspace(home);
		const stableHome = join(home, 'machines', 'stable', 'home');
		const r = run(['--delete-home', 'stable'], {home});
		expect(r.status).toBe(1);
		expect(r.stderr.toLowerCase()).toContain('without a tty');
		expect(existsSync(stableHome)).toBe(true);
	});

	it('errors on a missing machine home (nothing to delete)', () => {
		const home = tempHome();
		mkdirSync(home, {recursive: true});
		const r = run(['--delete-home', 'ghost', '--yes'], {home});
		expect(r.status).toBe(1);
	});

	it('rejects an invalid machine name', () => {
		const home = tempHome();
		mkdirSync(home, {recursive: true});
		const r = run(['--delete-home', 'a/b', '--yes'], {home});
		expect(r.status).toBe(1);
		expect(r.stderr.toLowerCase()).toContain('invalid machine name');
	});
});

describe('--delete-project <project>', () => {
	it('--yes deletes the project files AND its per-machine sessions across homes, keeps the homes', () => {
		const home = tempHome();
		const {alphaFolder, betaFolder} = seedWorkspace(home);

		const r = run(['--delete-project', 'alpha', '--yes'], {home});
		expect(r.status).toBe(0);
		// alpha's files gone.
		expect(existsSync(alphaFolder)).toBe(false);
		// alpha's session dir gone in BOTH machine homes.
		expect(existsSync(sessionDir(home, 'recon', 'alpha'))).toBe(false);
		expect(existsSync(sessionDir(home, 'stable', 'alpha'))).toBe(false);
		// the homes themselves survive (seed marker + other project sessions).
		expect(
			existsSync(
				join(
					home,
					'machines',
					'recon',
					'home',
					'.pi',
					'agent',
					'.anon-pi-seed',
				),
			),
		).toBe(true);
		// a DIFFERENT project (beta) is completely untouched: files + its session.
		expect(existsSync(join(betaFolder, 'file.txt'))).toBe(true);
		expect(existsSync(sessionDir(home, 'recon', 'beta'))).toBe(true);
	});

	it('requires a project argument', () => {
		const home = tempHome();
		mkdirSync(home, {recursive: true});
		const r = run(['--delete-project', '--yes'], {home});
		expect(r.status).toBe(1);
	});

	it('non-TTY without --yes ABORTS and deletes nothing', () => {
		const home = tempHome();
		const {alphaFolder} = seedWorkspace(home);
		const r = run(['--delete-project', 'alpha'], {home});
		expect(r.status).toBe(1);
		expect(r.stderr.toLowerCase()).toContain('without a tty');
		expect(existsSync(alphaFolder)).toBe(true);
		expect(existsSync(sessionDir(home, 'recon', 'alpha'))).toBe(true);
	});

	it('errors when nothing exists to delete (no files, no sessions)', () => {
		const home = tempHome();
		mkdirSync(home, {recursive: true});
		const r = run(['--delete-project', 'ghost', '--yes'], {home});
		expect(r.status).toBe(1);
	});

	it('rejects an invalid project name', () => {
		const home = tempHome();
		mkdirSync(home, {recursive: true});
		const r = run(['--delete-project', 'a/b', '--yes'], {home});
		expect(r.status).toBe(1);
		expect(r.stderr.toLowerCase()).toContain('invalid project name');
	});
});

describe('isolation: the real ~/.anon-pi is never touched', () => {
	it('delete-home + delete-project run only under the temp home', () => {
		const realHome = join(homedir(), '.anon-pi');
		const before = existsSync(realHome) ? statSync(realHome).mtimeMs : null;

		const home = tempHome();
		seedWorkspace(home);
		run(['--delete-project', 'alpha', '--yes'], {home});
		run(['--delete-home', 'stable', '--yes'], {home});

		const after = existsSync(realHome) ? statSync(realHome).mtimeMs : null;
		expect(after).toBe(before);
	});
});
