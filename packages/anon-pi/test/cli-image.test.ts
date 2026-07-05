// End-to-end dispatch for `anon-pi image {snapshot,list}` (ADR-0003): spawn the
// built CLI against a TEMP anon-pi home and assert the DISPATCH + parse-error +
// help behaviour, with netcage forced OFF so NO real image store is ever
// touched (hermetic, mirroring the old snapshot CLI test).
//
// The pure grammar/tag/label seam is covered by image-verbs.test.ts; this covers
// only the thin I/O boundary: that `image` is dispatched as a noun (never parsed
// as a project), that a bad grammar errors, that snapshot/list exit at
// netcageMissing BEFORE any commit/list (never mutating the real store), and
// that a now-reserved pre-existing project folder does not crash the menu.
//
// Requires the package to be built (dist/cli.js); CI builds before test.
import {describe, it, expect} from 'vitest';
import {existsSync, mkdirSync, mkdtempSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const cli = join(
	dirname(fileURLToPath(import.meta.url)),
	'..',
	'dist',
	'cli.js',
);

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

// Force netcage OFF by narrowing PATH to the base dirs, so `hasNetcage()` is
// false and the verb exits at netcageMissing BEFORE resolving/committing/listing
// any real container or image. These tests must NEVER reach `netcage commit` /
// `netcage images` (that could mutate/read the real store).
const NO_NETCAGE = {PATH: '/usr/bin:/bin'};

describe('image snapshot', () => {
	it('with netcage unavailable, exits 1 and writes no machine (never commits)', () => {
		const home = tempHome();
		const r = run(['image', 'snapshot', 'webscan'], {home, env: NO_NETCAGE});
		expect(r.status).toBe(1);
		expect(r.stderr.toLowerCase()).toContain('netcage');
	});

	it('--create-machine refuses to clobber an existing machine (before netcage/commit)', () => {
		const home = tempHome();
		run(['machine', 'create', 'toolbox', '--image', 'my/pi:tag'], {home});
		const r = run(
			['image', 'snapshot', 'webscan', '--create-machine', 'toolbox'],
			{home, env: NO_NETCAGE},
		);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain('already exists');
	});

	it('--update-machine refuses a MISSING machine (before netcage/commit)', () => {
		const home = tempHome();
		const r = run(
			['image', 'snapshot', 'webscan', '--update-machine', 'toolbox'],
			{home, env: NO_NETCAGE},
		);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain('no machine');
	});

	it('--create-machine + --update-machine together is a grammar error', () => {
		const home = tempHome();
		const r = run(
			[
				'image',
				'snapshot',
				'webscan',
				'--create-machine',
				'a',
				'--update-machine',
				'b',
			],
			{home},
		);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain('mutually exclusive');
	});

	it('rejects an invalid name and an invalid -m filter (traversal guard)', () => {
		const home = tempHome();
		expect(run(['image', 'snapshot', 'a/b'], {home}).status).toBe(1);
		expect(run(['image', 'snapshot', 'ok', '-m', 'a/b'], {home}).status).toBe(
			1,
		);
	});

	it('rejects a reserved name (e.g. `image`) with a clear reserved-name error', () => {
		const home = tempHome();
		const r = run(['image', 'snapshot', 'image'], {home});
		expect(r.status).toBe(1);
		expect(r.stderr.toLowerCase()).toContain('reserved name');
	});
});

describe('image list', () => {
	it('with netcage unavailable, exits 1 (never reads the real store)', () => {
		const home = tempHome();
		const r = run(['image', 'list'], {home, env: NO_NETCAGE});
		expect(r.status).toBe(1);
		expect(r.stderr.toLowerCase()).toContain('netcage');
	});
});

describe('image is dispatched as a NOUN (before the launch grammar)', () => {
	it('`image bogus` is an image parse error, not a launch', () => {
		const home = tempHome();
		const r = run(['image', 'bogus'], {home});
		expect(r.status).toBe(1);
		expect(r.stderr.toLowerCase()).toContain('unknown image subcommand');
	});

	it('`image` with no subcommand errors clearly', () => {
		const home = tempHome();
		const r = run(['image'], {home});
		expect(r.status).toBe(1);
		expect(r.stderr).toContain('needs a subcommand');
	});
});

describe('image --help', () => {
	it('`image --help` prints the image help (not the global one)', () => {
		const r = run(['image', '--help'], {home: tempHome()});
		expect(r.status).toBe(0);
		expect(r.stdout).toContain('anon-pi image -');
		expect(r.stdout).toContain('snapshot');
		expect(r.stdout).toContain('list');
		expect(r.stdout).toContain('--create-machine');
		expect(r.stdout).toContain('--update-machine');
		expect(r.stdout).not.toContain('launch pi inside a netcage');
	});
});

describe('reserved-name fix: a now-reserved pre-existing folder does not crash', () => {
	it('a project folder named `image` is silently skipped from the menu (no crash)', () => {
		// Create a projects root with a folder whose name is NOW reserved (`image`).
		// The bare menu filters project folders through the tolerant isProjectName,
		// so the folder is skipped rather than crashing the menu. Without a proxy
		// the launch fails-closed AFTER the menu is built, so we assert the run does
		// not crash on the reserved folder itself (no unhandled throw / stack).
		const home = tempHome();
		const projects = join(home, 'projects');
		mkdirSync(join(projects, 'image'), {recursive: true});
		mkdirSync(join(projects, 'ok'), {recursive: true});
		const r = run([], {
			home,
			env: {ANON_PI_PROJECTS: projects},
		});
		// It must not crash with a Node stack trace on the reserved folder.
		expect(r.stderr).not.toMatch(/invalid project name .*image/i);
		expect(r.stderr).not.toContain('    at '); // no unhandled JS stack
		expect(existsSync(join(projects, 'image'))).toBe(true);
	});
});
