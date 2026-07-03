// End-to-end launch dispatch for grammar A: spawn the built CLI with a FAKE
// `netcage` on PATH (so no real jail runs) that records the argv it was called
// with, and assert the composed netcage command + the no-TTY discipline + exit
// code propagation. The pure decisions (parse / RunPlan / run-vs-start) are
// tested at the module seam; this covers only the thin I/O the CLI adds.
//
// Requires the package to be built (dist/cli.js); CI builds before test.
import {describe, it, expect, beforeAll} from 'vitest';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from 'node:fs';
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

let fakeBin: string;
let argvLog: string;

// Spawn the CLI with the fake netcage on PATH and a temp anon-pi home. `tty`
// controls whether stdin is a TTY (the CLI's no-TTY discipline reads
// process.stdin.isTTY); a non-tty stdin is the default under spawnSync.
function run(
	args: string[],
	opts: {home: string; tty?: boolean; env?: Record<string, string>} = {
		home: '',
	},
) {
	return spawnSync(process.execPath, [cli, ...args], {
		encoding: 'utf8',
		// a pipe stdin is NOT a TTY; that models the no-TTY case. There is no
		// portable way to fake a TTY from a test, so TTY-required paths are only
		// asserted for their ERROR (no-tty) branch here.
		env: {
			...process.env,
			PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
			ANON_PI_IMAGE: 'my/pi:tag',
			ANON_PI_LLM: '192.168.1.150:8080',
			ANON_PI_PROXY: 'socks5h://127.0.0.1:1080',
			ANON_PI_HOME: opts.home,
			ANON_PI_ARGV_LOG: argvLog,
			...(opts.env ?? {}),
		},
	});
}

function lastArgv(): string[] {
	if (!existsSync(argvLog)) return [];
	const lines = readFileSync(argvLog, 'utf8').trim().split('\n');
	const last = lines[lines.length - 1] ?? '';
	return last === '' ? [] : (JSON.parse(last) as string[]);
}

beforeAll(() => {
	fakeBin = mkdtempSync(join(tmpdir(), 'anon-pi-fakebin-'));
	argvLog = join(fakeBin, 'argv.log');
	// a fake `netcage` that appends its argv (JSON) to $ANON_PI_ARGV_LOG then
	// exits 0. `netcage --help` (the install probe) and `netcage ps` (the kept
	// query) must also succeed; the query prints nothing (an empty listing).
	const nc = join(fakeBin, 'netcage');
	writeFileSync(
		nc,
		[
			'#!/usr/bin/env node',
			'const fs = require("fs");',
			'const argv = process.argv.slice(2);',
			'if (argv[0] === "--help") process.exit(0);',
			'if (argv[0] === "ps") process.exit(0);', // empty kept listing
			'if (process.env.ANON_PI_ARGV_LOG) {',
			'  fs.appendFileSync(process.env.ANON_PI_ARGV_LOG, JSON.stringify(argv) + "\\n");',
			'}',
			'process.exit(0);',
		].join('\n'),
		{mode: 0o755},
	);
});

describe('anon-pi <project> <pi-args…> (headless: runs without a TTY)', () => {
	it('spawns netcage run with the composed argv and exits 0', () => {
		const home = mkdtempSync(join(tmpdir(), 'anon-pi-home-'));
		const r = run(['recon', '-p', 'do a thing'], {home});
		expect(r.status).toBe(0);
		const argv = lastArgv();
		expect(argv[0]).toBe('run');
		// cwd is /projects/recon; the forwarded args are the trailing argv.
		const w = argv.indexOf('-w');
		expect(argv[w + 1]).toBe('/projects/recon');
		expect(argv.slice(-3)).toEqual(['pi', '-p', 'do a thing']);
	});

	it('the composed argv ALWAYS carries --proxy + the one --allow-direct (forced egress)', () => {
		const home = mkdtempSync(join(tmpdir(), 'anon-pi-home-'));
		const r = run(['recon', '-p', 'x'], {home});
		expect(r.status).toBe(0);
		const argv = lastArgv();
		const pi = argv.indexOf('--proxy');
		expect(pi).toBeGreaterThan(-1);
		expect(argv[pi + 1]).toBe('socks5h://127.0.0.1:1080');
		expect(argv.filter((a) => a === '--allow-direct')).toHaveLength(1);
		const di = argv.indexOf('--allow-direct');
		expect(argv[di + 1]).toBe('192.168.1.150:8080');
	});

	it('a headless run mounts <home>:/root and <projects-root>:/projects', () => {
		const home = mkdtempSync(join(tmpdir(), 'anon-pi-home-'));
		const r = run(['recon', '-p', 'x'], {home});
		expect(r.status).toBe(0);
		const joined = lastArgv().join(' ');
		expect(joined).toContain(`${home}/machines/default/home:/root`);
		expect(joined).toContain(`${home}/projects:/projects`);
	});

	it('propagates a non-zero netcage exit code', () => {
		const home = mkdtempSync(join(tmpdir(), 'anon-pi-home-'));
		// a netcage that exits 7 for `run`
		const nc = join(fakeBin, 'netcage');
		writeFileSync(
			nc,
			[
				'#!/usr/bin/env node',
				'const argv = process.argv.slice(2);',
				'if (argv[0] === "--help" || argv[0] === "ps") process.exit(0);',
				'process.exit(7);',
			].join('\n'),
			{mode: 0o755},
		);
		const r = run(['recon', '-p', 'x'], {home});
		expect(r.status).toBe(7);
		// restore the recording fake for the remaining tests
		writeFileSync(
			nc,
			[
				'#!/usr/bin/env node',
				'const fs = require("fs");',
				'const argv = process.argv.slice(2);',
				'if (argv[0] === "--help" || argv[0] === "ps") process.exit(0);',
				'if (process.env.ANON_PI_ARGV_LOG) fs.appendFileSync(process.env.ANON_PI_ARGV_LOG, JSON.stringify(argv) + "\\n");',
				'process.exit(0);',
			].join('\n'),
			{mode: 0o755},
		);
	});
});

describe('no-TTY discipline', () => {
	it('bare `anon-pi` (menu) errors without a TTY', () => {
		const home = mkdtempSync(join(tmpdir(), 'anon-pi-home-'));
		const r = run([], {home});
		expect(r.status).toBe(1);
		expect(r.stderr).toContain('no TTY');
	});

	it('an interactive `anon-pi <project>` (no forwarded args) errors without a TTY', () => {
		const home = mkdtempSync(join(tmpdir(), 'anon-pi-home-'));
		const r = run(['recon'], {home});
		expect(r.status).toBe(1);
		expect(r.stderr).toContain('no TTY');
	});

	it('`--shell` errors without a TTY', () => {
		const home = mkdtempSync(join(tmpdir(), 'anon-pi-home-'));
		const r = run(['--shell'], {home});
		expect(r.status).toBe(1);
		expect(r.stderr).toContain('no TTY');
	});
});

describe('resolution + errors', () => {
	it('a missing proxy fails closed with the required-proxy guidance', () => {
		const home = mkdtempSync(join(tmpdir(), 'anon-pi-home-'));
		const r = run(['recon', '-p', 'x'], {
			home,
			env: {ANON_PI_PROXY: ''},
		});
		expect(r.status).toBe(1);
		expect(r.stderr).toContain('ANON_PI_PROXY');
	});

	it('rejects an invalid project name with a clear error', () => {
		const home = mkdtempSync(join(tmpdir(), 'anon-pi-home-'));
		const r = run(['a/b', '-p', 'x'], {home});
		expect(r.status).toBe(1);
		expect(r.stderr.toLowerCase()).toContain('invalid project name');
	});

	it('--help prints the new model and NOT the removed surface', () => {
		const home = mkdtempSync(join(tmpdir(), 'anon-pi-home-'));
		const r = run(['--help'], {home});
		expect(r.status).toBe(0);
		expect(r.stdout).toContain('--shell');
		expect(r.stdout).toContain('--keep');
		expect(r.stdout).toContain('machine');
		// the retired surface must be gone from HELP
		expect(r.stdout).not.toContain('--ephemeral');
		expect(r.stdout).not.toContain('--fresh');
		expect(r.stdout).not.toMatch(/\bimport\b/);
	});
});

describe('machine.json image + -m machine selection', () => {
	it('-m <machine> mounts THAT machine home and uses its machine.json image', () => {
		const home = mkdtempSync(join(tmpdir(), 'anon-pi-home-'));
		const mdir = join(home, 'machines', 'webveil');
		mkdirSync(mdir, {recursive: true});
		writeFileSync(
			join(mdir, 'machine.json'),
			JSON.stringify({image: 'my/webveil:tag'}),
		);
		const r = run(['-m', 'webveil', 'recon', '-p', 'x'], {home});
		expect(r.status).toBe(0);
		const argv = lastArgv();
		expect(argv.join(' ')).toContain(`${home}/machines/webveil/home:/root`);
		// the image (from machine.json) is the arg right before `sh -c`.
		expect(argv).toContain('my/webveil:tag');
	});
});
