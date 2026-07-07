import {describe, it, expect} from 'vitest';
import {
	AnonPiError,
	ANON_ACCOUNT,
	parsePersonaArgs,
	planPersonaAdd,
	buildPersonaTeardownScript,
	personaAccount,
	composeTorPersonaProxy,
	PERSONA_BYO_UNIQUENESS_WARNING,
	PERSONA_HOME_MODE,
	type PersonaAddInputs,
} from '../src/index.js';

// The PURE `persona add` pieces (prd `multi-persona-hardened-accounts`,
// decisions 4-8, superseding ADR-0006): the `persona <verb>` grammar, the BYO
// uniqueness warning wording, and the resumable provisioning PLANNER. All pure +
// injected: no real getent/Tor/sudo/useradd here. The impure wiring is covered
// end-to-end by cli-persona.test.ts (stubbed PATH + temp homes).

describe('parsePersonaArgs: the `persona <verb>` grammar', () => {
	it('parses `add <name>` into {verb:add, name}', () => {
		expect(parsePersonaArgs(['add', 'alice'])).toEqual({
			verb: 'add',
			name: 'alice',
		});
	});

	it('parses a bare `add` (no name) into the DEFAULT persona (name undefined)', () => {
		expect(parsePersonaArgs(['add'])).toEqual({verb: 'add'});
	});

	it('errors (AnonPiError) on a missing subcommand', () => {
		expect(() => parsePersonaArgs([])).toThrow(AnonPiError);
	});

	it('errors on an unknown subcommand (only add | rm)', () => {
		expect(() => parsePersonaArgs(['list'])).toThrow(AnonPiError);
		expect(() => parsePersonaArgs(['bogus'])).toThrow(AnonPiError);
	});

	it('parses `rm <name>` and a bare `rm` (default persona), with --yes', () => {
		expect(parsePersonaArgs(['rm', 'alice'])).toEqual({
			verb: 'rm',
			name: 'alice',
			yes: false,
		});
		expect(parsePersonaArgs(['rm'])).toEqual({verb: 'rm', yes: false});
		expect(parsePersonaArgs(['rm', 'alice', '--yes'])).toEqual({
			verb: 'rm',
			name: 'alice',
			yes: true,
		});
		expect(parsePersonaArgs(['rm', 'alice', '-y'])).toEqual({
			verb: 'rm',
			name: 'alice',
			yes: true,
		});
	});

	it('takes the name FIRST; LEAVES trailing flag tokens for the CLI', () => {
		// flags are impure-flow knobs the CLI parses (flag arity lives there); the
		// pure grammar keeps only the verb + the leading bare name.
		expect(parsePersonaArgs(['add', 'alice', '--tor'])).toEqual({
			verb: 'add',
			name: 'alice',
		});
		// a leading flag => the default persona (no name), flags left to the CLI.
		expect(
			parsePersonaArgs(['add', '--proxy', 'socks5h://127.0.0.1:1080']),
		).toEqual({verb: 'add', name: undefined});
	});
});

describe('PERSONA_BYO_UNIQUENESS_WARNING: the one-line BYO warning', () => {
	it('warns the endpoint must be unique + steers to Tor + no used-endpoint list', () => {
		expect(PERSONA_BYO_UNIQUENESS_WARNING).toMatch(/unique to this persona/i);
		expect(PERSONA_BYO_UNIQUENESS_WARNING).toMatch(/share an exit/i);
		expect(PERSONA_BYO_UNIQUENESS_WARNING).toMatch(/prefer Tor/i);
		expect(PERSONA_BYO_UNIQUENESS_WARNING).toMatch(/no.*list/i);
	});
});

const base: PersonaAddInputs = {
	account: personaAccount('alice'),
	loginUser: 'operator',
	anonPiPath: '/usr/local/bin/anon-pi',
	loginHome: '/home/operator',
	accountExists: false,
};

describe('planPersonaAdd: resumable across account creation', () => {
	it('account MISSING -> wait-for-account with the Tier-2 command block + instruction', () => {
		const plan = planPersonaAdd(base);
		expect(plan.kind).toBe('wait-for-account');
		if (plan.kind !== 'wait-for-account') throw new Error('unreachable');
		// the Tier-2 block creates the persona account (copy-paste commands).
		expect(plan.script).toContain('useradd -m anon-alice');
		expect(plan.script).toContain('loginctl enable-linger anon-alice');
		expect(plan.script).toContain(
			'operator ALL=(anon-alice) /usr/local/bin/anon-pi',
		);
		// no script FILE framing; it is pasted into a root shell entered first.
		expect(plan.script).not.toContain('#!/bin/sh');
		expect(plan.instruction).toMatch(/become root/i);
		expect(plan.instruction).toContain('anon-alice');
	});

	it('account EXISTS -> continue-tier1 with the persona home (mode 700) + its config', () => {
		const config = {proxy: composeTorPersonaProxy('anon-alice')};
		const plan = planPersonaAdd({
			...base,
			accountExists: true,
			anonHome: '/home/anon-alice/.anon-pi',
			config,
		});
		expect(plan.kind).toBe('continue-tier1');
		if (plan.kind !== 'continue-tier1') throw new Error('unreachable');
		expect(plan.anonHome).toBe('/home/anon-alice/.anon-pi');
		expect(plan.mode).toBe(PERSONA_HOME_MODE);
		expect(PERSONA_HOME_MODE).toBe(0o700);
		expect(plan.config).toEqual(config);
	});

	it('already fully provisioned -> already-provisioned (idempotent no-op re-run)', () => {
		const plan = planPersonaAdd({
			...base,
			accountExists: true,
			anonHome: '/home/anon-alice/.anon-pi',
			config: {proxy: composeTorPersonaProxy('anon-alice')},
			alreadyProvisioned: true,
		});
		expect(plan.kind).toBe('already-provisioned');
	});

	it('the continue branch REQUIRES a resolved home + config (else a programming error)', () => {
		expect(() => planPersonaAdd({...base, accountExists: true})).toThrow(
			AnonPiError,
		);
	});

	it('the default persona uses account `anon` (empty-suffix), no special-casing', () => {
		const plan = planPersonaAdd({
			account: ANON_ACCOUNT,
			loginUser: 'operator',
			anonPiPath: '/usr/local/bin/anon-pi',
			loginHome: '/home/operator',
			accountExists: false,
		});
		expect(plan.kind).toBe('wait-for-account');
		if (plan.kind !== 'wait-for-account') throw new Error('unreachable');
		expect(plan.script).toContain('useradd -m anon');
	});
});

describe('buildPersonaTeardownScript: the root teardown block for `persona rm`', () => {
	it('emits the ordered teardown for a named persona (sudoers, linger, userdel -r)', () => {
		const script = buildPersonaTeardownScript(personaAccount('alice'));
		// become root first, never a script shebang.
		expect(script).toMatch(/^sudo -i\b/m);
		expect(script).not.toContain('#!/bin/sh');
		// remove the scoped sudoers rule for this account.
		expect(script).toContain("rm -f '/etc/sudoers.d/anon-pi-anon-alice'");
		// disable linger, then delete the account + home.
		expect(script).toContain('loginctl disable-linger anon-alice');
		expect(script).toContain('userdel -r anon-alice');
		// the DESTRUCTIVE warning is present (userdel -r erases transcripts).
		expect(script).toMatch(/IRREVERSIBLE/);
		// ORDER: sudoers rule removed BEFORE userdel (nothing dangles).
		expect(script.indexOf('rm -f')).toBeLessThan(script.indexOf('userdel'));
		expect(script.indexOf('disable-linger')).toBeLessThan(
			script.indexOf('userdel'),
		);
	});

	it('targets the default `anon` account for a bare teardown', () => {
		const script = buildPersonaTeardownScript(ANON_ACCOUNT);
		expect(script).toContain('userdel -r anon');
		expect(script).toContain("rm -f '/etc/sudoers.d/anon-pi-anon'");
	});
});
