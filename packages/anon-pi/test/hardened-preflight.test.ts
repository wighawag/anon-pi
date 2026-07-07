import {describe, it, expect} from 'vitest';
import {
	ANON_ACCOUNT,
	NETCAGE_MIN_VERSION,
	compareVersionTriples,
	evaluateHardenedPreflight,
	lingerRemediation,
	netcageVersionRemediation,
	netcageVersionSatisfies,
	parseNetcageVersion,
	subidRemediation,
	tunRemediation,
	xdgRuntimeRemediation,
	anonPiBinaryRemediation,
	type HardenedPreflightProbes,
} from '../src/index.js';

// The PURE hardened-deployment preflight (docs/adr/0006, prd
// `hardened-dedicated-account-deployment` story 6). A half-provisioned `anon`
// account must fail LOUDLY with remediation. Each check is a pure predicate over
// an INJECTED probe result (the real `/etc/subuid` read, `loginctl`, `stat
// /dev/net/tun`, `netcage --version` live in cli.ts, wired by the
// init-provisioning task). NO test here runs a real netcage/loginctl/stat or
// reads a real system path: every probe result is injected and every assertion
// is on the returned struct / remediation strings.

/** All-pass probe inputs; individual tests flip ONE field to exercise a failure. */
const allPass: HardenedPreflightProbes = {
	// a real SYSTEM anon-pi path (not under a home, not a shim, not .js): suitable.
	anonPiResolvedPath: '/usr/local/bin/anon-pi',
	loginHome: '/home/wighawag',
	subidRangesPresent: true,
	lingerEnabled: true,
	tunAccessible: true,
	xdgRuntimeDirPresent: true,
	netcageVersion: 'netcage 0.11.0',
};

describe('NETCAGE_MIN_VERSION: the version floor is ONE named constant', () => {
	it('is the confirmed 0.11.0 (uid-scoped store, netcage ADR-0017)', () => {
		expect(NETCAGE_MIN_VERSION).toBe('0.11.0');
	});
});

describe('parseNetcageVersion: parse rule + unparseable branch', () => {
	it('parses a bare x.y.z', () => {
		expect(parseNetcageVersion('0.11.0')).toEqual([0, 11, 0]);
	});

	it('parses a `netcage x.y.z` line', () => {
		expect(parseNetcageVersion('netcage 0.11.2')).toEqual([0, 11, 2]);
	});

	it('parses a `vX.Y.Z` tag form', () => {
		expect(parseNetcageVersion('v1.2.3')).toEqual([1, 2, 3]);
	});

	it('keeps the numeric core of a pre-release/build suffix', () => {
		expect(parseNetcageVersion('0.11.0-rc1')).toEqual([0, 11, 0]);
		expect(parseNetcageVersion('0.11.0+build.5')).toEqual([0, 11, 0]);
	});

	it('is UNPARSEABLE (undefined) when there is no dotted triple', () => {
		expect(parseNetcageVersion('')).toBeUndefined();
		expect(parseNetcageVersion('unknown')).toBeUndefined();
		expect(parseNetcageVersion('netcage version ?')).toBeUndefined();
		// a bare two-part version is NOT the x.y.z the rule requires.
		expect(parseNetcageVersion('0.11')).toBeUndefined();
	});
});

describe('compareVersionTriples: the comparator contract', () => {
	it('orders major, then minor, then patch', () => {
		expect(compareVersionTriples([0, 11, 0], [0, 11, 0])).toBe(0);
		expect(compareVersionTriples([0, 10, 9], [0, 11, 0])).toBeLessThan(0);
		expect(compareVersionTriples([0, 12, 0], [0, 11, 0])).toBeGreaterThan(0);
		expect(compareVersionTriples([1, 0, 0], [0, 99, 99])).toBeGreaterThan(0);
	});
});

describe('netcageVersionSatisfies: >= floor, with unparseable = not satisfied', () => {
	it('passes on exactly the floor and above', () => {
		expect(netcageVersionSatisfies('0.11.0')).toBe(true);
		expect(netcageVersionSatisfies('0.11.1')).toBe(true);
		expect(netcageVersionSatisfies('1.0.0')).toBe(true);
		expect(netcageVersionSatisfies('netcage 0.12.3')).toBe(true);
	});

	it('FAILS below the floor (e.g. 0.10.0)', () => {
		expect(netcageVersionSatisfies('0.10.0')).toBe(false);
		expect(netcageVersionSatisfies('0.9.99')).toBe(false);
	});

	it('FAILS on an unparseable version (never a silent pass)', () => {
		expect(netcageVersionSatisfies('unknown')).toBe(false);
		expect(netcageVersionSatisfies('')).toBe(false);
	});
});

describe('evaluateHardenedPreflight: all-pass', () => {
	it('reports ok with no failures when every probe passes', () => {
		const res = evaluateHardenedPreflight(allPass);
		expect(res.ok).toBe(true);
		expect(res.failures).toEqual([]);
	});
});

describe('evaluateHardenedPreflight: the anon-pi-binary cross-account check', () => {
	it('PASSES for a system anon-pi path', () => {
		expect(evaluateHardenedPreflight(allPass).ok).toBe(true);
	});

	it('FAILS for a Volta per-user shim (the reported bug), with remediation', () => {
		const path = '/home/wighawag/.volta/bin/volta-shim';
		const res = evaluateHardenedPreflight({
			...allPass,
			anonPiResolvedPath: path,
		});
		const f = res.failures.find((x) => x.id === 'anon-pi-binary');
		expect(f).toBeDefined();
		// under-login-home wins (it is under /home/wighawag), so that is the reason.
		expect(f?.remediation).toBe(
			anonPiBinaryRemediation(path, 'under-login-home', ANON_ACCOUNT),
		);
		// frames it around the hardened CHOICE, gives the concrete install command,
		// and reassures that Volta/nvm keeps precedence on the login shell.
		expect(f?.remediation).toContain('HARDENED');
		expect(f?.remediation).toContain('sudo npm install -g anon-pi');
		expect(f?.remediation).toContain('system-wide');
		expect(f?.remediation).toMatch(/Volta\/nvm keeps precedence/);
		expect(f?.remediation).toMatch(/volta uninstall anon-pi/);
	});

	it('FAILS for a shim OUTSIDE the home (version-manager-dir reason)', () => {
		const res = evaluateHardenedPreflight({
			...allPass,
			loginHome: '/root',
			anonPiResolvedPath: '/opt/.nvm/versions/node/x/bin/anon-pi',
		});
		const f = res.failures.find((x) => x.id === 'anon-pi-binary');
		expect(f?.remediation).toBe(
			anonPiBinaryRemediation(
				'/opt/.nvm/versions/node/x/bin/anon-pi',
				'version-manager-shim',
				ANON_ACCOUNT,
			),
		);
	});

	it('PASSES a system cli.js (shebang npm-global bin), FAILS for no binary', () => {
		// a system-path `.js` (the npm-global bin target) is runnable by the account.
		expect(
			evaluateHardenedPreflight({
				...allPass,
				loginHome: '/home/wighawag',
				anonPiResolvedPath: '/usr/local/lib/node_modules/anon-pi/dist/cli.js',
			}).failures.some((f) => f.id === 'anon-pi-binary'),
		).toBe(false);
		expect(
			evaluateHardenedPreflight({
				...allPass,
				anonPiResolvedPath: undefined,
			}).failures.some((f) => f.id === 'anon-pi-binary'),
		).toBe(true);
	});
});

describe('evaluateHardenedPreflight: each check pass/fail branch + exact remediation', () => {
	it('FAILS the subuid/subgid check with its exact remediation', () => {
		const res = evaluateHardenedPreflight({
			...allPass,
			subidRangesPresent: false,
		});
		expect(res.ok).toBe(false);
		const f = res.failures.find((x) => x.id === 'subid');
		expect(f?.remediation).toBe(subidRemediation(ANON_ACCOUNT));
		// the remediation names the account, the two files, and points at the
		// `useradd -m` that auto-allocates the ranges (no hard-coded range count).
		expect(f?.remediation).toContain('/etc/subuid');
		expect(f?.remediation).toContain('/etc/subgid');
		expect(f?.remediation).toContain(`useradd -m ${ANON_ACCOUNT}`);
	});

	it('FAILS the linger check with its exact remediation', () => {
		const res = evaluateHardenedPreflight({...allPass, lingerEnabled: false});
		const f = res.failures.find((x) => x.id === 'linger');
		expect(f?.remediation).toBe(lingerRemediation(ANON_ACCOUNT));
		expect(f?.remediation).toContain('loginctl enable-linger anon');
	});

	it('FAILS the /dev/net/tun check with its exact remediation', () => {
		const res = evaluateHardenedPreflight({...allPass, tunAccessible: false});
		const f = res.failures.find((x) => x.id === 'tun');
		expect(f?.remediation).toBe(tunRemediation());
		expect(f?.remediation).toContain('/dev/net/tun');
	});

	it('FAILS the account $XDG_RUNTIME_DIR check with its exact remediation', () => {
		const res = evaluateHardenedPreflight({
			...allPass,
			xdgRuntimeDirPresent: false,
		});
		const f = res.failures.find((x) => x.id === 'xdg-runtime');
		expect(f?.remediation).toBe(xdgRuntimeRemediation(ANON_ACCOUNT));
		expect(f?.remediation).toContain('XDG_RUNTIME_DIR');
	});
});

describe('evaluateHardenedPreflight: netcage version pass/fail/absent/unparseable', () => {
	it('passes netcage exactly at the floor', () => {
		const res = evaluateHardenedPreflight({
			...allPass,
			netcageVersion: '0.11.0',
		});
		expect(res.ok).toBe(true);
	});

	it('FAILS on a too-old netcage (0.10.0) with the too-old remediation', () => {
		const res = evaluateHardenedPreflight({
			...allPass,
			netcageVersion: '0.10.0',
		});
		const f = res.failures.find((x) => x.id === 'netcage-version');
		expect(f).toBeDefined();
		expect(f?.remediation).toBe(netcageVersionRemediation('0.10.0'));
		expect(f?.remediation).toContain('too old');
		expect(f?.remediation).toContain(NETCAGE_MIN_VERSION);
	});

	it('FAILS LOUD when netcage is ABSENT (undefined) with the not-found remediation', () => {
		const res = evaluateHardenedPreflight({
			...allPass,
			netcageVersion: undefined,
		});
		const f = res.failures.find((x) => x.id === 'netcage-version');
		expect(f).toBeDefined();
		expect(f?.remediation).toBe(netcageVersionRemediation(undefined));
		expect(f?.remediation).toContain('was not found');
		expect(f?.remediation).toContain(NETCAGE_MIN_VERSION);
	});

	it('FAILS LOUD when the netcage version is UNPARSEABLE (never a silent pass)', () => {
		const res = evaluateHardenedPreflight({
			...allPass,
			netcageVersion: 'netcage version ?',
		});
		const f = res.failures.find((x) => x.id === 'netcage-version');
		expect(f).toBeDefined();
		expect(f?.remediation).toBe(netcageVersionRemediation('netcage version ?'));
		expect(f?.remediation).toContain('could not parse');
	});

	it('absent and too-old give DISTINCT remediations', () => {
		expect(netcageVersionRemediation(undefined)).not.toBe(
			netcageVersionRemediation('0.10.0'),
		);
	});
});

describe('evaluateHardenedPreflight: composition (ordered list of all failures)', () => {
	it('reports EVERY failure in the fixed check order', () => {
		const res = evaluateHardenedPreflight({
			anonPiResolvedPath: undefined,
			loginHome: '/home/wighawag',
			subidRangesPresent: false,
			lingerEnabled: false,
			tunAccessible: false,
			xdgRuntimeDirPresent: false,
			netcageVersion: '0.10.0',
		});
		expect(res.ok).toBe(false);
		expect(res.failures.map((f) => f.id)).toEqual([
			'anon-pi-binary',
			'subid',
			'linger',
			'tun',
			'xdg-runtime',
			'netcage-version',
		]);
	});
});

describe('the preflight introduces NO NETCAGE_GRAPHROOT knob', () => {
	it('no remediation mentions NETCAGE_GRAPHROOT (uid-scoped store handles itself)', () => {
		const res = evaluateHardenedPreflight({
			anonPiResolvedPath: '/usr/local/bin/anon-pi',
			loginHome: '/home/wighawag',
			subidRangesPresent: false,
			lingerEnabled: false,
			tunAccessible: false,
			xdgRuntimeDirPresent: false,
			netcageVersion: undefined,
		});
		for (const f of res.failures) {
			expect(f.remediation).not.toContain('NETCAGE_GRAPHROOT');
		}
	});
});
