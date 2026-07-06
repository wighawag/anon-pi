import {describe, it, expect} from 'vitest';
import {
	ANON_ACCOUNT,
	shouldRedirectToAnon,
	buildAnonSudoArgv,
	buildAnonSuFallback,
	type HardenedInvocation,
} from '../src/index.js';

// The PURE core of the hardened self-re-exec invocation (docs/adr/0006):
// a should-redirect predicate + the `sudo -u anon -i <anon-pi> …` argv builder
// and its `su - anon -c '…'` fallback string. Both the "am I anon?" identity and
// the anon-pi path are INJECTED, so nothing here spawns, sets a uid, or calls a
// privilege syscall. No test invokes real sudo/su.

describe('hardened invocation: shouldRedirectToAnon (loop-guarded, always on hardened)', () => {
	it('redirects on a hardened install when the caller is NOT anon', () => {
		expect(shouldRedirectToAnon({hardened: true, isAnon: false})).toBe(true);
	});

	it('does NOT redirect when the caller already IS anon (no self-loop)', () => {
		expect(shouldRedirectToAnon({hardened: true, isAnon: true})).toBe(false);
	});

	it('does NOT redirect when the install is not hardened (any identity)', () => {
		expect(shouldRedirectToAnon({hardened: false, isAnon: false})).toBe(false);
		expect(shouldRedirectToAnon({hardened: false, isAnon: true})).toBe(false);
	});
});

describe('hardened invocation: buildAnonSudoArgv (login -i form)', () => {
	it('composes the exact `sudo -u anon -i <abs-anon-pi> <args…>` argv', () => {
		const argv = buildAnonSudoArgv({
			anonPiPath: '/usr/local/bin/anon-pi',
			forwardedArgs: ['recon', '--mount', '/tmp/x'],
		});
		expect(argv).toEqual([
			'sudo',
			'-u',
			ANON_ACCOUNT,
			'-i',
			'/usr/local/bin/anon-pi',
			'recon',
			'--mount',
			'/tmp/x',
		]);
	});

	it('carries no forwarded args cleanly (bare re-exec)', () => {
		expect(
			buildAnonSudoArgv({anonPiPath: '/opt/anon-pi', forwardedArgs: []}),
		).toEqual(['sudo', '-u', 'anon', '-i', '/opt/anon-pi']);
	});

	it('only ever emits a sudo argv, never a privilege syscall (structural)', () => {
		const argv = buildAnonSudoArgv({
			anonPiPath: '/usr/local/bin/anon-pi',
			forwardedArgs: ['--version'],
		});
		expect(argv[0]).toBe('sudo');
	});
});

describe('hardened invocation: buildAnonSuFallback (`su - anon -c` string form)', () => {
	it('composes the exact `su - anon -c` argv with a single quoted command string', () => {
		const argv = buildAnonSuFallback({
			anonPiPath: '/usr/local/bin/anon-pi',
			forwardedArgs: ['recon', '--mount', '/tmp/x'],
		});
		expect(argv).toEqual([
			'su',
			'-',
			ANON_ACCOUNT,
			'-c',
			"'/usr/local/bin/anon-pi' 'recon' '--mount' '/tmp/x'",
		]);
	});

	it('shell-quotes args so spaces/specials cannot break out of the -c string', () => {
		const argv = buildAnonSuFallback({
			anonPiPath: '/usr/local/bin/anon-pi',
			forwardedArgs: ['a b', "it's"],
		});
		expect(argv[4]).toBe("'/usr/local/bin/anon-pi' 'a b' 'it'\\''s'");
	});

	it('is a bare re-exec with no forwarded args', () => {
		expect(
			buildAnonSuFallback({anonPiPath: '/opt/anon-pi', forwardedArgs: []}),
		).toEqual(['su', '-', 'anon', '-c', "'/opt/anon-pi'"]);
	});

	it('only ever emits a su argv, never a privilege syscall (structural)', () => {
		const argv = buildAnonSuFallback({
			anonPiPath: '/opt/anon-pi',
			forwardedArgs: [],
		});
		expect(argv[0]).toBe('su');
	});
});

describe('hardened invocation: buildAnonSudoArgv targets a SELECTED persona account', () => {
	it('re-execs into `anon-<name>` when an account is passed (multi-persona)', () => {
		const argv = buildAnonSudoArgv({
			anonPiPath: '/usr/local/bin/anon-pi',
			forwardedArgs: ['--as', 'alice', 'recon'],
			account: 'anon-alice',
		});
		expect(argv).toEqual([
			'sudo',
			'-u',
			'anon-alice',
			'-i',
			'/usr/local/bin/anon-pi',
			'--as',
			'alice',
			'recon',
		]);
	});

	it('defaults to `anon` when no account is passed (v1 byte-identical)', () => {
		expect(
			buildAnonSudoArgv({anonPiPath: '/opt/anon-pi', forwardedArgs: []}),
		).toEqual(['sudo', '-u', ANON_ACCOUNT, '-i', '/opt/anon-pi']);
	});

	it('the su fallback also targets the selected persona account', () => {
		const argv = buildAnonSuFallback({
			anonPiPath: '/usr/local/bin/anon-pi',
			forwardedArgs: ['--as', 'alice'],
			account: 'anon-alice',
		});
		expect(argv.slice(0, 3)).toEqual(['su', '-', 'anon-alice']);
	});
});

describe('hardened invocation: the account name is pinned', () => {
	it('names the dedicated account `anon`', () => {
		expect(ANON_ACCOUNT).toBe('anon');
	});

	it('accepts a HardenedInvocation shape for the builders', () => {
		const inv: HardenedInvocation = {
			anonPiPath: '/usr/local/bin/anon-pi',
			forwardedArgs: [],
		};
		expect(buildAnonSudoArgv(inv)[0]).toBe('sudo');
	});
});
