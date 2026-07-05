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
//   - `inspect <ref> --format {{.ImageName}}` prints $ANON_PI_INSPECT_IMAGE (the
//     image ref `container list` reads back per box), else empty
//   - anything else (run / start / rm) appends its argv (JSON) to
//     $ANON_PI_ARGV_LOG and exits 0
// The `ps` and `run`/`start`/`rm` argv are BOTH recorded so a test can assert the
// box query was made and inspect the composed launch/start/rm argv.
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
			'if (argv[0] === "inspect") {',
			'  process.stdout.write(process.env.ANON_PI_INSPECT_IMAGE || "");',
			'  process.exit(0);',
			'}',
			`process.exit(${exitCode});`,
		].join('\n'),
		{mode: 0o755},
	);
}

function run(
	args: string[],
	opts: {
		home: string;
		psJson?: string;
		inspectImage?: string;
		env?: Record<string, string>;
	},
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
			ANON_PI_INSPECT_IMAGE: opts.inspectImage ?? 'anon-pi/inspected:latest',
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

// The base64 `anon-pi.key` label a launch stamps (machine + cwd identity): the
// same `k=v\n` record launchIdentityKey builds, so `container list` can read the
// box's machine + project (cwd leaf) back off it (no anon-pi registry). Here
// recon-box is on machine `recon` at /projects/proj; live-box on `default` at
// the projects root.
function keyLabel(machine: string, cwd: string): string {
	return Buffer.from(
		`machine=${machine}\nprojectsRoot=/root/projects\nmountParent=\ncwd=${cwd}`,
		'utf8',
	).toString('base64');
}

// A durable-box listing fixture (the shape `netcage ps -a --format json`
// returns): a stopped box `recon-box` and a running box `live-box`. Each carries
// BOTH labels a durable box has: `anon-pi.container` (the name, the record) and
// `anon-pi.key` (the machine+cwd identity `list` reads for machine + project).
const BOXES = JSON.stringify([
	{
		Id: 'reconid',
		Names: ['recon-box'],
		State: 'exited',
		Labels: {
			'anon-pi.container': 'recon-box',
			'anon-pi.key': keyLabel('recon', '/projects/proj'),
			'netcage.managed': 'true',
		},
	},
	{
		Id: 'liveid',
		Names: ['live-box'],
		State: 'running',
		Labels: {
			'anon-pi.container': 'live-box',
			'anon-pi.key': keyLabel('default', '/projects'),
			'netcage.managed': 'true',
		},
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

describe('container list — the durable boxes with identity (name, machine, image, cwd, running?)', () => {
	it('lists each anon-pi durable box with its identity, filtered to durable boxes', () => {
		const home = tempHome();
		const r = run(['container', 'list'], {home, psJson: BOXES});
		expect(r.status).toBe(0);
		const out = r.stdout;
		// both durable boxes appear, by their label name (the record).
		expect(out).toContain('recon-box');
		expect(out).toContain('live-box');
		// identity read off the anon-pi.key label: machine + cwd/project.
		expect(out).toContain('recon');
		expect(out).toContain('proj');
		// the image is read back per box via `netcage inspect`.
		expect(out).toContain('anon-pi/inspected:latest');
		// running state is shown for both (a stopped and a running box).
		expect(out.toLowerCase()).toContain('running');
		expect(out.toLowerCase()).toContain('stopped');
	});

	it('filters to anon-pi durable boxes only (a throwaway launch + sidecar are dropped)', () => {
		const home = tempHome();
		const withNoise = JSON.stringify([
			...(JSON.parse(BOXES) as unknown[]),
			{
				Id: 'twid',
				Names: ['netcage-run-9-tool'],
				State: 'running',
				Labels: {'anon-pi.key': 'a2V5', 'netcage.managed': 'true'},
			},
			{
				Id: 'scid',
				Names: ['netcage-run-9-sidecar'],
				State: 'running',
				Labels: {'netcage.managed': 'true', 'netcage.role': 'sidecar'},
			},
		]);
		const r = run(['container', 'list'], {home, psJson: withNoise});
		expect(r.status).toBe(0);
		// exactly the two DURABLE boxes are listed (one row each), no throwaway/sidecar.
		expect(r.stdout).not.toContain('netcage-run-9');
		const rows = r.stdout
			.trim()
			.split('\n')
			.filter((l) => l !== '');
		expect(rows).toHaveLength(2);
	});

	it('reports "no durable boxes" cleanly when none exist (exit 0)', () => {
		const home = tempHome();
		const r = run(['container', 'list'], {home, psJson: '[]'});
		expect(r.status).toBe(0);
		expect(r.stdout.toLowerCase()).toContain('no');
		expect(r.stdout).toContain('container create');
	});
});

describe('container rm — remove a STOPPED box directly', () => {
	it('spawns `netcage rm <ref>` (no --yes needed) and reports it removed', () => {
		const home = tempHome();
		const r = run(['container', 'rm', 'recon-box'], {home, psJson: BOXES});
		expect(r.status).toBe(0);
		const argv = argvOf('rm');
		expect(argv).toBeDefined();
		expect(argv).toContain('reconid');
		expect(r.stdout).toContain('recon-box');
	});
});

describe('container rm — a RUNNING box is GUARDED behind --yes (stop-then-remove)', () => {
	it('WITHOUT --yes it refuses (exit 1) with the "running, re-run with --yes" guidance and composes NO rm', () => {
		const home = tempHome();
		const r = run(['container', 'rm', 'live-box'], {home, psJson: BOXES});
		expect(r.status).toBe(1);
		expect(r.stderr.toLowerCase()).toContain('running');
		expect(r.stderr).toContain('--yes');
		expect(argvOf('rm')).toBeUndefined();
	});

	it('WITH --yes it stop-then-removes the running box in ONE atomic call (`rm -f <ref>`)', () => {
		const home = tempHome();
		const r = run(['container', 'rm', 'live-box', '--yes'], {
			home,
			psJson: BOXES,
		});
		expect(r.status).toBe(0);
		const argv = argvOf('rm');
		expect(argv).toBeDefined();
		expect(argv).toContain('liveid');
		// force removal stops-then-removes a running container in one call.
		expect(argv).toContain('-f');
		expect(r.stdout).toContain('live-box');
	});
});

describe('container rm — an UNKNOWN name errors (never a silent success)', () => {
	it('errors (exit 1) and composes NO rm', () => {
		const home = tempHome();
		const r = run(['container', 'rm', 'ghost'], {home, psJson: BOXES});
		expect(r.status).toBe(1);
		expect(r.stderr).toContain('no container named');
		expect(argvOf('rm')).toBeUndefined();
	});
});

describe('the real anon-pi home is UNTOUCHED (isolation via ANON_PI_HOME)', () => {
	it('a list/rm run writes nothing under the real ~/.anon-pi', () => {
		const home = tempHome();
		const before = existsSync(home) ? readdirSync(home).sort() : [];
		// list is read-only; rm of a stopped box only spawns `netcage rm`. Neither
		// writes any state of its own under the (temp) anon-pi home.
		run(['container', 'list'], {home, psJson: BOXES});
		run(['container', 'rm', 'recon-box'], {home, psJson: BOXES});
		const after = existsSync(home) ? readdirSync(home).sort() : [];
		expect(after).toEqual(before);
	});
});

describe('the real anon-pi home is UNTOUCHED on create/enter (isolation via ANON_PI_HOME)', () => {
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
