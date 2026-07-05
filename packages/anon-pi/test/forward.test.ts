// Pure surface for the `forward` / `ports` host-access verbs: port-arg parsing,
// the argv parsers, the running-container filter, and the `netcage ports --json`
// consumer. PURE (no spawn/fs): every input is injected.
import {describe, it, expect} from 'vitest';
import {
	AnonPiError,
	parsePortArg,
	parseForwardArgs,
	parsePortsArgs,
	parseKeptKey,
	keyProject,
	resolveManagedMatches,
	parseNetcagePsJson,
	parseNetcagePortsJson,
	forwardablePorts,
	formatPortsHint,
	launchIdentityKey,
	type LaunchIntent,
	type Machine,
	type ManagedContainer,
} from '../src/index.js';

describe('parsePortArg ([hostPort:]jailPort, docker/kubectl host-first)', () => {
	it('a single port maps host==jail', () => {
		expect(parsePortArg('3001')).toEqual({
			hostPort: 3001,
			jailPort: 3001,
			raw: '3001',
		});
	});

	it('host:jail remaps and keeps the raw netcage token', () => {
		expect(parsePortArg('8080:3001')).toEqual({
			hostPort: 8080,
			jailPort: 3001,
			raw: '8080:3001',
		});
	});

	it('host:jail with equal sides normalises raw to the bare port', () => {
		expect(parsePortArg('3001:3001').raw).toBe('3001');
	});

	it('rejects non-numeric, out-of-range, and too many colons', () => {
		for (const bad of ['abc', '0', '65536', '8080:0', ':3001', '1:2:3', '']) {
			expect(() => parsePortArg(bad), bad).toThrow(AnonPiError);
		}
	});
});

describe('parseForwardArgs (positional is ALWAYS the project)', () => {
	it('a bare numeric positional is a PROJECT, not a port', () => {
		const c = parseForwardArgs(['3001']);
		expect(c.project).toBe('3001');
		expect(c.port).toBeUndefined();
	});

	it('--port carries the port; positional stays the project', () => {
		const c = parseForwardArgs(['recon', '--port', '8080:3001']);
		expect(c.project).toBe('recon');
		expect(c.port).toEqual({hostPort: 8080, jailPort: 3001, raw: '8080:3001'});
	});

	it('-p is the short form of --port', () => {
		expect(parseForwardArgs(['-p', '5173']).port?.jailPort).toBe(5173);
	});

	it('no positional => no project filter (all containers)', () => {
		const c = parseForwardArgs(['--port', '3001']);
		expect(c.project).toBeUndefined();
	});

	it('-m sets the machine; --bind is carried through', () => {
		const c = parseForwardArgs(['-m', 'webveil', '--bind', '0.0.0.0']);
		expect(c.machine).toBe('webveil');
		expect(c.machineExplicit).toBe(true);
		expect(c.bind).toBe('0.0.0.0');
	});

	it('errors on an unknown flag, a missing arg, a second positional, a bad port', () => {
		expect(() => parseForwardArgs(['--nope'])).toThrow(AnonPiError);
		expect(() => parseForwardArgs(['--port'])).toThrow(AnonPiError);
		expect(() => parseForwardArgs(['a', 'b'])).toThrow(AnonPiError);
		expect(() => parseForwardArgs(['--port', '99999'])).toThrow(AnonPiError);
	});
});

describe('parsePortsArgs', () => {
	it('takes an optional project + -m, no port', () => {
		const c = parsePortsArgs(['recon', '-m', 'webveil']);
		expect(c.project).toBe('recon');
		expect(c.machine).toBe('webveil');
	});

	it('rejects a second positional and unknown flags', () => {
		expect(() => parsePortsArgs(['a', 'b'])).toThrow(AnonPiError);
		expect(() => parsePortsArgs(['--port', '3001'])).toThrow(AnonPiError);
	});
});

describe('parseKeptKey + keyProject', () => {
	const key = [
		'machine=default',
		'projectsRoot=/home/u/.anon-pi/projects',
		'mountParent=',
		'cwd=/projects/recon',
	].join('\n');

	it('decodes the stamped key fields', () => {
		expect(parseKeptKey(key)).toEqual({
			machine: 'default',
			projectsRoot: '/home/u/.anon-pi/projects',
			mountParent: '',
			cwd: '/projects/recon',
		});
	});

	it('keyProject reads the leaf project from the cwd', () => {
		expect(keyProject(parseKeptKey(key))).toBe('recon');
	});

	it('a root cwd maps to the `.` token; a shell cwd (/root) to empty', () => {
		expect(keyProject({...parseKeptKey(key), cwd: '/projects'})).toBe('.');
		expect(keyProject({...parseKeptKey(key), cwd: '/work'})).toBe('.');
		expect(keyProject({...parseKeptKey(key), cwd: '/root'})).toBe('');
	});
});

describe('launchIdentityKey — the label stamped on EVERY (throwaway) launch', () => {
	// The identity label survives the retirement of --keep/--rm: forward/ports
	// resolve a RUNNING container by it (parseKeptKey -> keyProject). It is no
	// longer a kept-container MATCH key, only a decodable identity for the live
	// container. It must still encode enough for keyProject (the cwd/project) and
	// the machine filter.
	const machine: Machine = {
		name: 'recon',
		home: '/tmp/anon-pi-home/machines/recon/home',
		image: 'my/pi:tag',
	};
	const baseIntent = (over: Partial<LaunchIntent> = {}): LaunchIntent => ({
		machine,
		mode: 'pi',
		projectsRoot: '/tmp/anon-pi-home/projects',
		project: 'recon',
		proxy: 'socks5h://127.0.0.1:9050',
		llmDirect: '192.168.1.150:8080',
		...over,
	});

	it('round-trips through parseKeptKey: machine + the project (via cwd) survive', () => {
		const f = parseKeptKey(launchIdentityKey(baseIntent()));
		expect(f.machine).toBe('recon');
		expect(keyProject(f)).toBe('recon');
	});

	it('names the machine so the forward/ports filter can scope by machine', () => {
		const f = parseKeptKey(
			launchIdentityKey(baseIntent({machine: {...machine, name: 'webveil'}})),
		);
		expect(f.machine).toBe('webveil');
	});

	it('encodes the `.` root and a --mount project so keyProject reads them', () => {
		expect(
			keyProject(parseKeptKey(launchIdentityKey(baseIntent({project: '.'})))),
		).toBe('.');
		expect(
			keyProject(
				parseKeptKey(
					launchIdentityKey(
						baseIntent({project: 'sub', mountParent: '/host/dev'}),
					),
				),
			),
		).toBe('sub');
	});

	it('is independent of the forced-egress inputs and forwarded pi args', () => {
		const a = launchIdentityKey(baseIntent());
		const b = launchIdentityKey(
			baseIntent({
				proxy: 'socks5h://127.0.0.1:1080',
				llmDirect: '10.0.0.5:1234',
				piArgs: ['-p', 'x'],
			}),
		);
		expect(a).toBe(b);
	});
});

describe('resolveManagedMatches (filter running containers by machine + project)', () => {
	const mk = (ref: string, machine: string, cwd: string): ManagedContainer => ({
		ref,
		name: ref,
		key: [
			`machine=${machine}`,
			'projectsRoot=/r',
			'mountParent=',
			`cwd=${cwd}`,
		].join('\n'),
	});
	const containers = [
		mk('c1', 'default', '/projects/recon'),
		mk('c2', 'default', '/projects/recon'), // same project, two containers
		mk('c3', 'default', '/projects/other'),
		mk('c4', 'webveil', '/projects/recon'),
	];

	it('filters by machine only (no project) => all on that machine', () => {
		const m = resolveManagedMatches({containers, machine: 'default'});
		expect(m.map((c) => c.ref)).toEqual(['c1', 'c2', 'c3']);
	});

	it('narrows by project (can still be several)', () => {
		const m = resolveManagedMatches({
			containers,
			machine: 'default',
			project: 'recon',
		});
		expect(m.map((c) => c.ref)).toEqual(['c1', 'c2']);
	});

	it('a different machine is excluded', () => {
		const m = resolveManagedMatches({
			containers,
			machine: 'webveil',
			project: 'recon',
		});
		expect(m.map((c) => c.ref)).toEqual(['c4']);
	});

	it('no match => empty', () => {
		expect(
			resolveManagedMatches({containers, machine: 'default', project: 'nope'}),
		).toEqual([]);
	});
});

describe('parseNetcagePsJson (netcage ps --format json => anon-pi containers)', () => {
	// The real netcage >= 0.10.0 shape: podman's JSON forwarded verbatim. Only
	// entries with an anon-pi.key label are anon-pi's (a sidecar has none).
	const tool = {
		Id: 'abc123',
		Names: ['netcage-run-1-tool'],
		State: 'running',
		Labels: {
			'anon-pi.key': 'a2V5', // base64('key') - RAW, decode is the CLI's job
			'netcage.managed': 'true',
			'netcage.role': 'tool',
		},
	};
	const sidecar = {
		Id: 'def456',
		Names: ['netcage-run-1-sidecar'],
		State: 'running',
		Labels: {'netcage.managed': 'true', 'netcage.role': 'sidecar'},
	};
	const stoppedTool = {...tool, Id: 'ghi789', State: 'exited'};

	it('keeps only anon-pi.key-labelled entries (drops the sidecar), RAW key', () => {
		const r = parseNetcagePsJson(JSON.stringify([tool, sidecar]));
		expect(r).toEqual([
			{key: 'a2V5', ref: 'abc123', name: 'netcage-run-1-tool'},
		]);
	});

	it('runningOnly drops a stopped container', () => {
		const all = parseNetcagePsJson(JSON.stringify([tool, stoppedTool]));
		expect(all.map((c) => c.ref)).toEqual(['abc123', 'ghi789']);
		const running = parseNetcagePsJson(JSON.stringify([tool, stoppedTool]), {
			runningOnly: true,
		});
		expect(running.map((c) => c.ref)).toEqual(['abc123']);
	});

	it('falls back to the Id as the display name when Names is absent', () => {
		const noName = {...tool, Names: undefined};
		expect(parseNetcagePsJson(JSON.stringify([noName]))[0].name).toBe('abc123');
	});

	it('returns [] on bad JSON, a non-array, or an entry with no Id', () => {
		expect(parseNetcagePsJson('not json')).toEqual([]);
		expect(parseNetcagePsJson('{}')).toEqual([]);
		expect(
			parseNetcagePsJson(JSON.stringify([{...tool, Id: undefined}])),
		).toEqual([]);
	});
});

describe('parseNetcagePortsJson + forwardablePorts + formatPortsHint', () => {
	const json = JSON.stringify([
		{address: '127.0.0.1', port: 53, loopbackOnly: true}, // netcage DNS
		{address: '0.0.0.0', port: 3001, loopbackOnly: false},
		{address: '::', port: 3001, loopbackOnly: false}, // dup port (v6)
		{address: '127.0.0.1', port: 5173, loopbackOnly: true},
	]);

	it('parses the netcage --json contract, dropping malformed entries', () => {
		const withJunk =
			'[{"address":"0.0.0.0","port":8080,"loopbackOnly":false},{"nope":1},42]';
		expect(parseNetcagePortsJson(withJunk)).toEqual([
			{address: '0.0.0.0', port: 8080, loopbackOnly: false},
		]);
	});

	it('returns [] on bad JSON or a non-array', () => {
		expect(parseNetcagePortsJson('not json')).toEqual([]);
		expect(parseNetcagePortsJson('{}')).toEqual([]);
	});

	it('forwardablePorts drops the DNS forwarder, dedups, sorts', () => {
		expect(forwardablePorts(parseNetcagePortsJson(json))).toEqual([3001, 5173]);
	});

	it('formatPortsHint renders a compact hint, or (none detected)', () => {
		expect(formatPortsHint(parseNetcagePortsJson(json))).toBe(
			'open: 3001, 5173',
		);
		expect(formatPortsHint([])).toBe('open: (none detected)');
	});
});
