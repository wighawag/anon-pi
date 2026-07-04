// End-to-end dispatch for `anon-pi init`: spawn the built CLI against a TEMP
// anon-pi home and assert the thin I/O the CLI adds around the pure decisions,
// the no-TTY discipline, and that the real ~/.anon-pi is never touched.
//
// init is INTERACTIVE (it needs a TTY for its prompts); there is no portable way
// to fake a TTY under spawnSync, so this suite covers the branches that do NOT
// need one: --help, the no-TTY refusal (which must write NOTHING), and arg
// validation. The interactive DECISIONS (proxy findings + never-label, handshake
// interpretation, verify exit-IP parse, config shape) are covered at the pure
// module seam by init-onboarding.test.ts (mirroring the launch suite, which also
// only asserts the ERROR branch for TTY-required paths).
//
// Requires the package to be built (dist/cli.js); CI builds before test.
import {describe, it, expect} from 'vitest';
import {existsSync, mkdtempSync, statSync} from 'node:fs';
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

// spawnSync pipes stdin, so process.stdin.isTTY is false: init hits its no-TTY
// branch. `input` is unused here (the no-TTY branch never reads a prompt).
function run(args: string[], opts: {home: string}) {
	return spawnSync(process.execPath, [cli, ...args], {
		encoding: 'utf8',
		env: {
			...process.env,
			ANON_PI_HOME: opts.home,
		},
	});
}

function tempHome(): string {
	return mkdtempSync(join(tmpdir(), 'anon-pi-home-'));
}

describe('anon-pi init --help', () => {
	it('prints the init help and exits 0 (no TTY needed)', () => {
		const home = tempHome();
		const r = run(['init', '--help'], {home});
		expect(r.status).toBe(0);
		expect(r.stdout.toLowerCase()).toContain('onboard');
		expect(r.stdout).toContain('netcage verify');
		// the help must not claim a provider label.
		expect(r.stdout.toLowerCase()).not.toContain('mullvad');
	});
});

describe('anon-pi init (no TTY)', () => {
	it('refuses honestly and writes NOTHING (no config, no machine)', () => {
		const home = tempHome();
		const r = run(['init'], {home});
		expect(r.status).toBe(1);
		expect(r.stderr.toLowerCase()).toContain('tty');
		// nothing was written to the temp home.
		expect(existsSync(join(home, 'config.json'))).toBe(false);
		expect(existsSync(join(home, 'machines', 'default'))).toBe(false);
	});

	it('rejects extra arguments', () => {
		const home = tempHome();
		const r = run(['init', 'bogus'], {home});
		expect(r.status).toBe(1);
		expect(r.stderr.toLowerCase()).toContain('no arguments');
	});
});

describe('isolation: the real ~/.anon-pi is never touched by init', () => {
	it('a no-TTY init run does not create/modify the real workspace', () => {
		const realHome = join(homedir(), '.anon-pi');
		const before = existsSync(realHome) ? statSync(realHome).mtimeMs : null;

		const home = tempHome();
		run(['init'], {home});
		run(['init', '--help'], {home});

		const after = existsSync(realHome) ? statSync(realHome).mtimeMs : null;
		expect(after).toBe(before);
	});
});
