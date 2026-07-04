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
	parseNetcagePortsJson,
	forwardablePorts,
	formatPortsHint,
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
