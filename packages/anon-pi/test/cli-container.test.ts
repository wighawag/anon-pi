// End-to-end dispatch for `anon-pi container {create,enter}` (the container
// ADR's durable-box lifecycle): spawn the built CLI with a FAKE `netcage` on
// PATH that records the argv it was called with AND serves a scripted `ps -a`
// listing (the durable-box query create's dup-check + enter's lookup read), so
// no real jail runs and no real container store is touched. We assert the
// COMPOSED netcage argv (create -> a durable `run` with NO --rm, a --name, the
// anon-pi.container label, forced egress intact; enter -> `netcage start -it`
// re-supplying the forced egress) and the REFUSALS (create on a dup, enter on
// unknown / already-running).
//
// The pure grammar (parse-container.test.ts), the durable run-plan
// (run-plan.test.ts), and the box reader (container-boxes.test.ts) are covered
// at their own seams; this covers only the thin I/O the CLI adds.
//
// Requires the package to be built (dist/cli.js); CI builds before test.
import {describe, it, expect, beforeEach} from 'vitest';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
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

// A fake `netcage` that:
//   - `--help` (the install probe) exits 0
//   - `ps …` prints $ANON_PI_PS_JSON (the scripted durable-box listing), else []
//   - anything else (run / start) appends its argv (JSON) to $ANON_PI_ARGV_LOG
//     and exits 0
// The `ps` and `run`/`start` argv are BOTH recorded so a test can assert the box
// query was made and inspect the composed launch/start argv.
function writeFakeNetcage(exitCode = 0): void {
	writeFileSync(
		join(fakeBin, 'netcage'),
		[
			'#!/usr/bin/env node',
			'const fs = require("fs");',
			'const argv = process.argv.slice(2);',
			'if (argv[0] === "--help") process.exit(0);',
			'if (process.env.ANON_PI_ARGV_LOG) {',
			'  fs.appendFileSync(process.env.ANON_PI_ARGV_LOG, JSON.stringify(argv) + "\\n");',
			'}',
			'if (argv[0] === "ps") {',
			'  process.stdout.write(process.env.ANON_PI_PS_JSON || "[]");',
			'  process.exit(0);',
			'}',
			`process.exit(${exitCode});`,
		].join('\n'),
		{mode: 0o755},
	);
}

function run(
	args: string[],
	opts: {home: string; psJson?: string; env?: Record<string, string>},
) {
	return spawnSync(process.execPath, [cli, ...args], {
		encoding: 'utf8',
		env: {
			...process.env,
			PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
			ANON_PI_IMAGE: 'my/pi:tag',
			ANON_PI_LLM: '192.168.1.150:8080',
			ANON_PI_PROXY: 'socks5h://127.0.0.1:1080',
			ANON_PI_HOME: opts.home,
			ANON_PI_ARGV_LOG: argvLog,
			ANON_PI_PS_JSON: opts.psJson ?? '[]',
			...(opts.env ?? {}),
		},
	});
}

// The container bodies open an interactive session, so they need a TTY; a
// spawnSync pipe stdin is NOT a TTY. These no-TTY runs assert the argv the CLI
// COMPOSED before the (unreachable-here) attach: create still records the
// `netcage run` it built; enter still records the `netcage start`. We read the
// recorded launch/start argv rather than a real attach.
function recordedArgvs(): string[][] {
	if (!existsSync(argvLog)) return [];
	return readFileSync(argvLog, 'utf8')
		.trim()
		.split('\n')
		.filter((l) => l !== '')
		.map((l) => JSON.parse(l) as string[]);
}

function argvOf(verb: string): string[] | undefined {
	return recordedArgvs().find((a) => a[0] === verb);
}

function tempHome(): string {
	return mkdtempSync(join(tmpdir(), 'anon-pi-home-'));
}

// A durable-box listing fixture (the shape `netcage ps -a --format json`
// returns): a stopped box `recon-box` and a running box `live-box`.
const BOXES = JSON.stringify([
	{
		Id: 'reconid',
		Names: ['recon-box'],
		State: 'exited',
		Labels: {'anon-pi.container': 'recon-box', 'netcage.managed': 'true'},
	},
	{
		Id: 'liveid',
		Names: ['live-box'],
		State: 'running',
		Labels: {'anon-pi.container': 'live-box', 'netcage.managed': 'true'},
	},
]);

beforeEach(() => {
	fakeBin = mkdtempSync(join(tmpdir(), 'anon-pi-fakebin-'));
	argvLog = join(fakeBin, 'argv.log');
	writeFakeNetcage();
});

describe('container create — composes a DURABLE launch (no --rm, named, labelled)', () => {
	it('spawns `netcage run` WITHOUT --rm, with --name + the anon-pi.container label', () => {
		const home = tempHome();
		run(['container', 'create', 'newbox', 'proj'], {home});
		const argv = argvOf('run');
		expect(argv).toBeDefined();
		expect(argv).not.toContain('--rm');
		const ni = argv!.indexOf('--name');
		expect(ni).toBeGreaterThan(-1);
		expect(argv![ni + 1]).toBe('newbox');
		expect(argv!.join(' ')).toContain('anon-pi.container=newbox');
	});

	it('freezes the cwd (the create-time project word) into the launch', () => {
		const home = tempHome();
		run(['container', 'create', 'newbox', 'proj'], {home});
		const argv = argvOf('run')!;
		const w = argv.indexOf('-w');
		expect(argv[w + 1]).toBe('/projects/proj');
	});

	it('keeps forced egress intact: --proxy + EXACTLY one --allow-direct', () => {
		const home = tempHome();
		run(['container', 'create', 'newbox', '--shell'], {home});
		const argv = argvOf('run')!;
		const pi = argv.indexOf('--proxy');
		expect(argv[pi + 1]).toBe('socks5h://127.0.0.1:1080');
		expect(argv.filter((a) => a === '--allow-direct')).toHaveLength(1);
		expect(argv[argv.indexOf('--allow-direct') + 1]).toBe('192.168.1.150:8080');
	});

	it('freezes the image via the launch chain (-i wins over the env fallback)', () => {
		const home = tempHome();
		// seed the default machine home so `-i` is allowed (a fresh home refuses -i).
		const mhome = join(home, 'machines', 'default', 'home', '.pi', 'agent');
		mkdirSync(mhome, {recursive: true});
		writeFileSync(join(mhome, '.anon-pi-seed'), '1\n');
		run(['container', 'create', 'newbox', '-i', 'over/ride:latest', 'proj'], {
			home,
		});
		const argv = argvOf('run')!;
		expect(argv).toContain('over/ride:latest');
		expect(argv).not.toContain('my/pi:tag'); // the ANON_PI_IMAGE fallback
	});

	it('-m picks the HOME (mounts THAT machine home)', () => {
		const home = tempHome();
		const mdir = join(home, 'machines', 'webveil');
		mkdirSync(mdir, {recursive: true});
		writeFileSync(
			join(mdir, 'machine.json'),
			JSON.stringify({image: 'my/webveil:tag'}),
		);
		run(['container', 'create', 'newbox', '-m', 'webveil', 'proj'], {home});
		const argv = argvOf('run')!;
		expect(argv.join(' ')).toContain(`${home}/machines/webveil/home:/root`);
		expect(argv).toContain('my/webveil:tag');
	});
});

describe('container create — FAILS FAST on an existing name (no re-enter, no clobber)', () => {
	it('errors (exit 1) and composes NO run when the box already exists', () => {
		const home = tempHome();
		const r = run(['container', 'create', 'recon-box', 'proj'], {
			home,
			psJson: BOXES,
		});
		expect(r.status).toBe(1);
		expect(r.stderr).toContain('already exists');
		// it refused BEFORE composing a launch (no `run` argv recorded).
		expect(argvOf('run')).toBeUndefined();
	});
});

describe('container enter — resumes a STOPPED box via `netcage start`', () => {
	it('spawns `netcage start -it <ref>` re-supplying the forced egress', () => {
		const home = tempHome();
		run(['container', 'enter', 'recon-box'], {home, psJson: BOXES});
		const argv = argvOf('start');
		expect(argv).toBeDefined();
		// the frozen container is addressed by its ref, no -i, no -w re-cwd.
		expect(argv).toContain('reconid');
		expect(argv).toContain('-it');
		expect(argv).not.toContain('-i');
		expect(argv).not.toContain('-w');
		// forced egress is re-supplied on the re-stand (start stands up the jail).
		expect(argv![argv!.indexOf('--proxy') + 1]).toBe(
			'socks5h://127.0.0.1:1080',
		);
		expect(argv!.filter((a) => a === '--allow-direct')).toHaveLength(1);
		expect(argv![argv!.indexOf('--allow-direct') + 1]).toBe(
			'192.168.1.150:8080',
		);
	});
});

describe('container enter — REFUSES an already-RUNNING box (not a second attach)', () => {
	it('errors (exit 1) with guidance and composes NO start', () => {
		const home = tempHome();
		const r = run(['container', 'enter', 'live-box'], {home, psJson: BOXES});
		expect(r.status).toBe(1);
		expect(r.stderr.toLowerCase()).toContain('running');
		expect(r.stderr).toContain('forward');
		expect(argvOf('start')).toBeUndefined();
	});
});

describe('container enter — errors on an UNKNOWN name (never a silent success)', () => {
	it('errors (exit 1) and composes NO start', () => {
		const home = tempHome();
		const r = run(['container', 'enter', 'ghost'], {home, psJson: BOXES});
		expect(r.status).toBe(1);
		expect(r.stderr).toContain('no container named');
		expect(argvOf('start')).toBeUndefined();
	});
});

describe('the real anon-pi home is UNTOUCHED (isolation via ANON_PI_HOME)', () => {
	it('a create/enter run writes nothing under the real ~/.anon-pi', () => {
		const home = tempHome();
		const before = existsSync(home) ? readdirSync(home).sort() : [];
		// enter of a stopped box: reads the box listing, spawns start, writes no
		// state of its own under the (temp) home; create likewise mutates only the
		// mounted host dirs it is pointed at, not the anon-pi home root layout.
		run(['container', 'enter', 'recon-box'], {home, psJson: BOXES});
		const after = existsSync(home) ? readdirSync(home).sort() : [];
		// enter creates NO new top-level entries under the anon-pi home.
		expect(after).toEqual(before);
	});
});
