import {describe, it, expect} from 'vitest';
import {
	ANON_ACCOUNT,
	buildTier2ProvisioningScript,
	personaAccount,
	type Tier2ProvisioningInputs,
} from '../src/index.js';

// The PURE Tier-2 root-provisioning COMMAND generator (prd
// `multi-persona-hardened-accounts` decisions 0 + 8, superseding ADR-0006).
// anon-pi is a rootless npm launcher: it must NEVER silently sudo. So for the
// root-requiring parts of provisioning a persona (create the `anon-<name>`
// account, enable-linger, the scoped sudoers snippet) it EMITS a block of
// COPY-PASTE COMMANDS the human pastes into a root shell they enter FIRST
// (`sudo -i`/`su -`) — there is NO `#!/bin/sh` script FILE written to disk (v1's
// artifact is retired: nothing to save/leak the persona name). subuid/subgid is
// auto-allocated by `useradd -m` (no explicit range line). This generator is
// PURE (account/login-user/binary injected) and the block it returns is NEVER
// executed by anon-pi and NEVER executed by any test here: every assertion is on
// the STRING.

const baseInputs: Tier2ProvisioningInputs = {
	account: ANON_ACCOUNT,
	loginUser: 'operator',
	anonPiPath: '/usr/local/bin/anon-pi',
};

describe('Tier-2 provisioning: copy-paste commands, NOT a #!/bin/sh script file', () => {
	it('emits a become-root line first (sudo -i / su -), never a script shebang', () => {
		const script = buildTier2ProvisioningScript(baseInputs);
		// the human enters a root shell FIRST, then pastes the commands.
		expect(script).toMatch(/^sudo -i\b/m);
		// no script-file framing at all.
		expect(script).not.toContain('#!/bin/sh');
		expect(script).not.toMatch(/\bset -eu\b/);
	});

	it('is a paste-able command block, never a saved file (no mktemp-to-a-script)', () => {
		const script = buildTier2ProvisioningScript(baseInputs);
		// nothing implies the user saves the block to a file and runs it.
		expect(script).not.toMatch(/save this/i);
		expect(script).not.toMatch(/chmod \+x/);
		expect(script).not.toMatch(/\bsh\s+\/tmp/);
	});
});

describe('Tier-2 provisioning: the required root commands', () => {
	it('emits `useradd -m <account>` (creates the account WITH a home dir)', () => {
		const script = buildTier2ProvisioningScript(baseInputs);
		expect(script).toMatch(/useradd\b/);
		expect(script).toMatch(/useradd[^\n]*-m\b/);
		expect(script).toMatch(/useradd[^\n]*\banon\b/);
	});

	it('emits `loginctl enable-linger anon`', () => {
		const script = buildTier2ProvisioningScript(baseInputs);
		expect(script).toContain('loginctl enable-linger anon');
	});

	it('emits the scoped sudoers snippet `<login-user> ALL=(anon) <anon-pi-binary>`', () => {
		const script = buildTier2ProvisioningScript(baseInputs);
		expect(script).toContain('operator ALL=(anon) /usr/local/bin/anon-pi');
	});

	it('validates the sudoers rule with `visudo -cf` before installing mode-0440', () => {
		const script = buildTier2ProvisioningScript(baseInputs);
		expect(script).toMatch(/visudo -cf\b/);
		expect(script).toMatch(/install -m 0440\b/);
		expect(script).toContain('/etc/sudoers.d/');
	});
});

describe('Tier-2 provisioning: NO explicit subuid/subgid range line', () => {
	it('does NOT append an explicit /etc/subuid or /etc/subgid range line', () => {
		const script = buildTier2ProvisioningScript(baseInputs);
		// subid is auto-allocated by `useradd -m`; anon-pi writes NO range line to
		// either file (no `>>/etc/subuid`/`>>/etc/subgid` append, no grep-guard).
		expect(script).not.toMatch(/>>?\s*\/etc\/subuid/);
		expect(script).not.toMatch(/>>?\s*\/etc\/subgid/);
		expect(script).not.toMatch(/grep[^\n]*\/etc\/sub[ug]id/);
		// no `anon:<start>:<count>` range triple anywhere.
		expect(script).not.toMatch(/anon:\d+:\d+/);
	});
});

describe('Tier-2 provisioning: the password is KEPT by default', () => {
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

describe('Tier-2 provisioning: what it must NOT emit', () => {
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

describe('Tier-2 provisioning: PURE + injected, both default and persona account', () => {
	it('injects the account, login user, and binary path verbatim', () => {
		const script = buildTier2ProvisioningScript({
			account: ANON_ACCOUNT,
			loginUser: 'alice',
			anonPiPath: '/opt/tools/anon-pi',
		});
		expect(script).toContain('alice ALL=(anon) /opt/tools/anon-pi');
		expect(script).toContain('/opt/tools/anon-pi');
	});

	it('works for a persona account `anon-<name>` (account injected)', () => {
		const account = personaAccount('alice');
		expect(account).toBe('anon-alice');
		const script = buildTier2ProvisioningScript({
			account,
			loginUser: 'operator',
			anonPiPath: '/usr/local/bin/anon-pi',
		});
		expect(script).toContain('useradd -m anon-alice');
		expect(script).toContain('loginctl enable-linger anon-alice');
		expect(script).toContain(
			'operator ALL=(anon-alice) /usr/local/bin/anon-pi',
		);
		// the sudoers file is scoped per persona account, so provisioning a
		// second persona does not clobber the first's rule file.
		expect(script).toContain('/etc/sudoers.d/anon-pi-anon-alice');
	});

	it('is deterministic (same inputs -> byte-identical block)', () => {
		expect(buildTier2ProvisioningScript(baseInputs)).toBe(
			buildTier2ProvisioningScript(baseInputs),
		);
	});
});
