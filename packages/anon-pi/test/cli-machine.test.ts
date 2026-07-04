// End-to-end dispatch for `anon-pi machine {create,list,set-image,rm}`: spawn the
// built CLI against a TEMP anon-pi home (ANON_PI_HOME) and assert the layout it
// writes, the list it prints, the set-image re-pin + WARNING (home untouched),
// and the rm confirm/`--yes`/non-TTY discipline. The pure parse/serialise/warn
// seam is covered by machine-verbs.test.ts; this covers only the thin I/O.
//
// These verbs write to a real workspace dir, so every test ISOLATES to a
// mkdtemp home and the suite also asserts the real ~/.anon-pi is never touched.
//
// Requires the package to be built (dist/cli.js); CI builds before test.
import {describe, it, expect, beforeAll} from 'vitest';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {homedir, tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

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

beforeAll(() => {
	// nothing to set up; each test uses its own temp home.
});

describe('machine create', () => {
	it('writes machines/<name>/{machine.json,home/} and pins --image', () => {
		const home = tempHome();
		const r = run(['machine', 'create', 'recon', '--image', 'my/pi:tag'], {
			home,
		});
		expect(r.status).toBe(0);
		const mdir = join(home, 'machines', 'recon');
		expect(statSync(join(mdir, 'home')).isDirectory()).toBe(true);
		const conf = JSON.parse(readFileSync(join(mdir, 'machine.json'), 'utf8'));
		expect(conf).toEqual({image: 'my/pi:tag'});
	});

	it('refuses to clobber an existing machine', () => {
		const home = tempHome();
		run(['machine', 'create', 'recon', '--image', 'my/pi:tag'], {home});
		const r = run(['machine', 'create', 'recon', '--image', 'other:tag'], {
			home,
		});
		expect(r.status).toBe(1);
		expect(r.stderr).toContain('already exists');
	});

	it('with no --image and no TTY, aborts (no machine written)', () => {
		const home = tempHome();
		const r = run(['machine', 'create', 'recon'], {home});
		expect(r.status).toBe(1);
		expect(r.stderr).toContain('no TTY');
		expect(existsSync(join(home, 'machines', 'recon'))).toBe(false);
	});

	it('rejects an invalid machine name', () => {
		const home = tempHome();
		const r = run(['machine', 'create', 'a/b', '--image', 'x:1'], {home});
		expect(r.status).toBe(1);
		expect(r.stderr.toLowerCase()).toContain('invalid machine name');
	});
});

describe('machine list', () => {
	it('prints each machine and its pinned image', () => {
		const home = tempHome();
		run(['machine', 'create', 'alpha', '--image', 'a/pi:1'], {home});
		run(['machine', 'create', 'beta', '--image', 'b/pi:2'], {home});
		const r = run(['machine', 'list'], {home});
		expect(r.status).toBe(0);
		expect(r.stdout).toContain('alpha');
		expect(r.stdout).toContain('a/pi:1');
		expect(r.stdout).toContain('beta');
		expect(r.stdout).toContain('b/pi:2');
	});

	it('reports an empty workspace clearly', () => {
		const home = tempHome();
		const r = run(['machine', 'list'], {home});
		expect(r.status).toBe(0);
		expect(r.stdout.toLowerCase()).toContain('no machines');
	});
});

describe('machine set-image', () => {
	it('re-pins the image, prints the WARNING, and leaves the home intact', () => {
		const home = tempHome();
		run(['machine', 'create', 'recon', '--image', 'old/pi:1'], {home});
		// drop a file in the home to prove set-image does not reseed/wipe it.
		const homeDir = join(home, 'machines', 'recon', 'home');
		mkdirSync(join(homeDir, '.pi', 'agent'), {recursive: true});
		writeFileSync(join(homeDir, '.pi', 'agent', 'keep'), 'x');

		const r = run(['machine', 'set-image', 'recon', 'new/pi:2'], {home});
		expect(r.status).toBe(0);
		expect(r.stderr).toContain('WARNING');
		expect(r.stderr).toContain('NOT reseeded');
		const conf = JSON.parse(
			readFileSync(join(home, 'machines', 'recon', 'machine.json'), 'utf8'),
		);
		expect(conf.image).toBe('new/pi:2');
		// the home file survived (no reseed, no wipe).
		expect(readFileSync(join(homeDir, '.pi', 'agent', 'keep'), 'utf8')).toBe(
			'x',
		);
	});

	it('preserves a per-machine projects override on a re-pin', () => {
		const home = tempHome();
		const mdir = join(home, 'machines', 'recon');
		mkdirSync(join(mdir, 'home'), {recursive: true});
		writeFileSync(
			join(mdir, 'machine.json'),
			JSON.stringify({image: 'old/pi:1', projects: '/dev/anon'}),
		);
		const r = run(['machine', 'set-image', 'recon', 'new/pi:2'], {home});
		expect(r.status).toBe(0);
		const conf = JSON.parse(readFileSync(join(mdir, 'machine.json'), 'utf8'));
		expect(conf).toEqual({image: 'new/pi:2', projects: '/dev/anon'});
	});

	it('errors on an unknown machine', () => {
		const home = tempHome();
		const r = run(['machine', 'set-image', 'ghost', 'x:1'], {home});
		expect(r.status).toBe(1);
		expect(r.stderr).toContain('no machine');
	});
});

describe('machine rm', () => {
	it('--yes deletes the machine + home', () => {
		const home = tempHome();
		run(['machine', 'create', 'recon', '--image', 'my/pi:tag'], {home});
		const mdir = join(home, 'machines', 'recon');
		expect(existsSync(mdir)).toBe(true);
		const r = run(['machine', 'rm', 'recon', '--yes'], {home});
		expect(r.status).toBe(0);
		expect(existsSync(mdir)).toBe(false);
	});

	it('non-TTY without --yes ABORTS and leaves the machine intact', () => {
		const home = tempHome();
		run(['machine', 'create', 'recon', '--image', 'my/pi:tag'], {home});
		const mdir = join(home, 'machines', 'recon');
		const r = run(['machine', 'rm', 'recon'], {home});
		expect(r.status).toBe(1);
		expect(r.stderr.toLowerCase()).toContain('without a tty');
		expect(existsSync(mdir)).toBe(true);
	});

	it('errors on an unknown machine', () => {
		const home = tempHome();
		const r = run(['machine', 'rm', 'ghost', '--yes'], {home});
		expect(r.status).toBe(1);
		expect(r.stderr).toContain('no machine');
	});
});

describe('machine snapshot', () => {
	it('refuses to clobber an existing target machine (before any commit)', () => {
		const home = tempHome();
		run(['machine', 'create', 'recon-net', '--image', 'my/pi:tag'], {home});
		const r = run(['machine', 'snapshot', 'recon', 'recon-net'], {home});
		expect(r.status).toBe(1);
		expect(r.stderr).toContain('already exists');
	});

	it('with no running container (or no netcage), exits 1 and writes no machine', () => {
		// Deterministic regardless of whether netcage is on PATH: either the
		// netcage-missing error or the no-running-container error, both exit 1 and
		// must NOT create the target machine. Force an empty PATH-ish netcage lookup
		// is not portable, so we assert the invariant that holds either way.
		const home = tempHome();
		const r = run(['machine', 'snapshot', 'ghost', 'ghost-snap'], {home});
		expect(r.status).toBe(1);
		expect(existsSync(join(home, 'machines', 'ghost-snap'))).toBe(false);
	});

	it('rejects an invalid new-name / source-name (traversal guard)', () => {
		const home = tempHome();
		expect(run(['machine', 'snapshot', 'a/b', 'ok'], {home}).status).toBe(1);
		expect(run(['machine', 'snapshot', 'ok', '..'], {home}).status).toBe(1);
	});
});

describe('isolation: the real ~/.anon-pi is never touched', () => {
	it('a full create/list/set-image/rm cycle writes only under the temp home', () => {
		const realHome = join(homedir(), '.anon-pi');
		const before = existsSync(realHome) ? statSync(realHome).mtimeMs : null;

		const home = tempHome();
		run(['machine', 'create', 'recon', '--image', 'my/pi:tag'], {home});
		run(['machine', 'list'], {home});
		run(['machine', 'set-image', 'recon', 'my/pi:2'], {home});
		run(['machine', 'rm', 'recon', '--yes'], {home});

		// The real workspace either still does not exist, or was not modified.
		const after = existsSync(realHome) ? statSync(realHome).mtimeMs : null;
		expect(after).toBe(before);
		// And the machine we created never appeared under the real home.
		expect(existsSync(join(realHome, 'machines', 'recon'))).toBe(false);
	});
});

describe('machine --help', () => {
	// `machine --help` must reach MACHINE_HELP, not the global HELP: the top-level
	// --help intercept excepts the subcommands that own their own help.
	it('`machine --help` prints the machine help (not the global one)', () => {
		const r = run(['machine', '--help'], {home: tempHome()});
		expect(r.status).toBe(0);
		expect(r.stdout).toContain('anon-pi machine - manage machines');
		expect(r.stdout).toContain('set-image');
		expect(r.stdout).toContain('snapshot');
		// NOT the global top-level help header.
		expect(r.stdout).not.toContain('launch pi inside a netcage');
	});

	it('`machine -h` also prints the machine help', () => {
		const r = run(['machine', '-h'], {home: tempHome()});
		expect(r.status).toBe(0);
		expect(r.stdout).toContain('anon-pi machine - manage machines');
	});
});
