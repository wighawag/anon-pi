import {describe, it, expect} from 'vitest';
import {
	ANON_ACCOUNT,
	SUBID_RANGE_COUNT,
	buildTier2ProvisioningScript,
	type Tier2ProvisioningInputs,
} from '../src/index.js';

// The PURE Tier-2 root-provisioning-script generator (docs/adr/0006, prd
// `hardened-dedicated-account-deployment` stories 4+5). anon-pi is a rootless
// npm launcher: it must NEVER silently sudo. So for the root-requiring parts of
// hardening (create the `anon` account, subuid/subgid ranges, enable-linger, the
// scoped sudoers snippet) it EMITS a reviewable script TEXT that the HUMAN runs
// with sudo. This generator is PURE (account/login-user/binary injected) and the
// script it returns is NEVER executed by anon-pi and NEVER executed by any test
// here: every assertion is on the STRING.

const baseInputs: Tier2ProvisioningInputs = {
	account: ANON_ACCOUNT,
	loginUser: 'operator',
	anonPiPath: '/usr/local/bin/anon-pi',
};

describe('Tier-2 provisioning script: the four required root steps', () => {
	it('emits `useradd` for the injected account (creating a home dir)', () => {
		const script = buildTier2ProvisioningScript(baseInputs);
		// creates the dedicated account with a home dir (-m).
		expect(script).toMatch(/useradd\b/);
		expect(script).toMatch(/useradd[^\n]*\banon\b/);
		expect(script).toMatch(/useradd[^\n]*-m\b/);
	});

	it('emits the /etc/subuid and /etc/subgid range lines for the account', () => {
		const script = buildTier2ProvisioningScript(baseInputs);
		expect(script).toContain('/etc/subuid');
		expect(script).toContain('/etc/subgid');
		// the subordinate-id range is `anon:<start>:<count>` on each file.
		expect(script).toMatch(new RegExp(`anon:\\d+:${SUBID_RANGE_COUNT}\\b`));
	});

	it('emits `loginctl enable-linger anon`', () => {
		const script = buildTier2ProvisioningScript(baseInputs);
		expect(script).toContain('loginctl enable-linger anon');
	});

	it('emits the scoped sudoers snippet `<login-user> ALL=(anon) <anon-pi-binary>`', () => {
		const script = buildTier2ProvisioningScript(baseInputs);
		expect(script).toContain('operator ALL=(anon) /usr/local/bin/anon-pi');
	});
});

describe('Tier-2 provisioning script: the password is KEPT by default', () => {
	it('does NOT contain a NOPASSWD token by default', () => {
		const script = buildTier2ProvisioningScript(baseInputs);
		expect(script).not.toMatch(/NOPASSWD/);
	});

	it('emits NOPASSWD only when nopasswd is opted IN (off by default)', () => {
		const optedIn = buildTier2ProvisioningScript({
			...baseInputs,
			nopasswd: true,
		});
		expect(optedIn).toContain(
			'operator ALL=(anon) NOPASSWD: /usr/local/bin/anon-pi',
		);
		// and the default (no flag / false) keeps the password.
		expect(
			buildTier2ProvisioningScript({...baseInputs, nopasswd: false}),
		).not.toMatch(/NOPASSWD/);
	});
});

describe('Tier-2 provisioning script: what it must NOT emit', () => {
	it('emits NO cross-user chown / workspace-migration line (that is the deferred harden verb)', () => {
		const script = buildTier2ProvisioningScript(baseInputs);
		expect(script).not.toMatch(/chown/);
		expect(script).not.toMatch(/\bmv\b/);
		expect(script).not.toMatch(/rsync/);
	});

	it('emits NO NETCAGE_GRAPHROOT export (the uid-scoped store handles itself)', () => {
		const script = buildTier2ProvisioningScript(baseInputs);
		expect(script).not.toMatch(/NETCAGE_GRAPHROOT/);
	});
});

describe('Tier-2 provisioning script: PURE + injected + idempotent', () => {
	it('injects the account, login user, and binary path verbatim', () => {
		const script = buildTier2ProvisioningScript({
			account: 'anon',
			loginUser: 'alice',
			anonPiPath: '/opt/tools/anon-pi',
		});
		expect(script).toContain('alice ALL=(anon) /opt/tools/anon-pi');
		expect(script).toContain('/opt/tools/anon-pi');
	});

	it('is idempotent on the subuid/subgid lines (guarded append, safe to re-run)', () => {
		const script = buildTier2ProvisioningScript(baseInputs);
		// re-running must not duplicate the range line: a grep-guard precedes the append.
		expect(script).toMatch(/grep[^\n]*\/etc\/subuid/);
		expect(script).toMatch(/grep[^\n]*\/etc\/subgid/);
	});

	it('is deterministic (same inputs -> byte-identical script)', () => {
		expect(buildTier2ProvisioningScript(baseInputs)).toBe(
			buildTier2ProvisioningScript(baseInputs),
		);
	});
});
