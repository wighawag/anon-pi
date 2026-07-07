import {describe, it, expect} from 'vitest';
import {
	ANON_ACCOUNT,
	PERSONA_ACCOUNT_PREFIX,
	AS_FLAG,
	AnonPiError,
	personaAccount,
	personaName,
	isAnonPersonaAccount,
	validatePersonaName,
	resolvePersonaSelection,
	shouldRedirectToPersona,
	stripAsFlag,
	type PersonaSelection,
} from '../src/index.js';

// The PURE core: N personas selected by a bare name (prd
// `multi-persona-hardened-accounts`, superseding ADR-0006). The dedicated
// account namespace is anon-pi's OWN: the default is `anonpi` (ANON_ACCOUNT) and
// named personas are `anonpi-<name>` (PERSONA_ACCOUNT_PREFIX), DISJOINT from the
// sibling tool anonctl's `anon` / `anon-<name>` namespace. Three pieces, all pure
// + injected: the name<->account mapping, the `--as` selection resolver over an
// INJECTED persona list, and the generalized self-re-exec loop guard ("am I the
// TARGET persona?"). No real sudo/whoami/fs here.

describe('persona mapping: personaAccount (bare name -> anonpi-<name>, default anonpi)', () => {
	it('maps a bare name to the namespaced account', () => {
		expect(personaAccount('alice')).toBe('anonpi-alice');
	});

	it('maps the default (absent / undefined) to the bare `anonpi`', () => {
		expect(personaAccount(undefined)).toBe(ANON_ACCOUNT);
		expect(personaAccount()).toBe(ANON_ACCOUNT);
	});

	it('maps the default (empty / whitespace-only) to the bare `anonpi`', () => {
		expect(personaAccount('')).toBe(ANON_ACCOUNT);
		expect(personaAccount('   ')).toBe(ANON_ACCOUNT);
	});

	it('trims surrounding whitespace before mapping', () => {
		expect(personaAccount('  alice  ')).toBe('anonpi-alice');
	});

	it('pins the canonical default account name + persona prefix', () => {
		expect(personaAccount()).toBe('anonpi');
		expect(ANON_ACCOUNT).toBe('anonpi');
		expect(PERSONA_ACCOUNT_PREFIX).toBe('anonpi-');
	});
});

describe('persona mapping: validatePersonaName (safe Unix-username suffix)', () => {
	it('accepts a plain lowercase name and returns it unchanged (trimmed)', () => {
		expect(validatePersonaName('alice')).toBe('alice');
		expect(validatePersonaName('  alice ')).toBe('alice');
	});

	it('accepts digits and internal hyphens', () => {
		expect(validatePersonaName('alice-2')).toBe('alice-2');
		expect(validatePersonaName('work-alt')).toBe('work-alt');
		expect(validatePersonaName('a1')).toBe('a1');
	});

	it('rejects an empty / whitespace-only name where a name is required', () => {
		expect(() => validatePersonaName('')).toThrow(AnonPiError);
		expect(() => validatePersonaName('   ')).toThrow(AnonPiError);
	});

	it('rejects a name already carrying the `anonpi-` prefix (double-prefix)', () => {
		expect(() => validatePersonaName('anonpi-alice')).toThrow(AnonPiError);
		expect(() => validatePersonaName('anonpi-')).toThrow(AnonPiError);
	});

	it('rejects uppercase and separators/whitespace that would break the account', () => {
		expect(() => validatePersonaName('Alice')).toThrow(AnonPiError);
		expect(() => validatePersonaName('a/b')).toThrow(AnonPiError);
		expect(() => validatePersonaName('a b')).toThrow(AnonPiError);
		expect(() => validatePersonaName('a:b')).toThrow(AnonPiError);
		expect(() => validatePersonaName('a_b')).toThrow(AnonPiError);
	});

	it('rejects a leading hyphen (must start alnum)', () => {
		expect(() => validatePersonaName('-alice')).toThrow(AnonPiError);
	});

	// NAMESPACE GUARD: a persona name must not re-enter the sibling tool anonctl's
	// account namespace (the bare `anon` or the `anon-` prefix), so the two tools'
	// account spaces stay disjoint and no confusing `anonpi-anon…` account is made.
	it('rejects the bare name `anon` (anonctl owns the bare `anon` account)', () => {
		expect(() => validatePersonaName('anon')).toThrow(AnonPiError);
		expect(() => personaAccount('anon')).toThrow(AnonPiError);
	});

	it('rejects a name starting with `anon-` (anonctl owns the `anon-` prefix)', () => {
		expect(() => validatePersonaName('anon-alice')).toThrow(AnonPiError);
		expect(() => validatePersonaName('anon-')).toThrow(AnonPiError);
		expect(() => personaAccount('anon-bob')).toThrow(AnonPiError);
	});

	it('personaAccount validates too (an invalid name yields a clear error)', () => {
		expect(() => personaAccount('Alice')).toThrow(AnonPiError);
		expect(() => personaAccount('anonpi-bob')).toThrow(AnonPiError);
	});
});

describe('persona mapping: personaName (inverse of personaAccount)', () => {
	it('maps a namespaced account back to its bare name', () => {
		expect(personaName('anonpi-alice')).toBe('alice');
	});

	it('maps the default account to the default (undefined bare name)', () => {
		expect(personaName('anonpi')).toBe(undefined);
	});

	it('returns undefined for a non-persona account', () => {
		expect(personaName('root')).toBe(undefined);
		expect(personaName('anonpialice')).toBe(undefined);
		// anonctl's own accounts are NOT anon-pi persona accounts.
		expect(personaName('anon')).toBe(undefined);
		expect(personaName('anon-alice')).toBe(undefined);
	});
});

describe('isAnonPersonaAccount (is this ANY anon-pi persona account?)', () => {
	it('is true for the default account `anonpi`', () => {
		expect(isAnonPersonaAccount('anonpi')).toBe(true);
	});

	it('is true for a namespaced persona account `anonpi-<name>`', () => {
		expect(isAnonPersonaAccount('anonpi-alice')).toBe(true);
	});

	it('is false for a non-persona account (login user, root, a near-miss)', () => {
		expect(isAnonPersonaAccount('wighawag')).toBe(false);
		expect(isAnonPersonaAccount('root')).toBe(false);
		// `anonpi-` with an empty suffix is NOT a valid persona account.
		expect(isAnonPersonaAccount('anonpi-')).toBe(false);
		// `anonpialice` (no hyphen) shares a prefix but is not a persona.
		expect(isAnonPersonaAccount('anonpialice')).toBe(false);
		// anonctl's accounts are a DIFFERENT namespace, not anon-pi personas.
		expect(isAnonPersonaAccount('anon')).toBe(false);
		expect(isAnonPersonaAccount('anon-alice')).toBe(false);
	});
});

describe('persona selection: resolvePersonaSelection (--as <name>, default anonpi, known? over injected list)', () => {
	it('absent --as resolves to the default `anonpi`, no name, known by default', () => {
		const sel = resolvePersonaSelection({args: ['recon', '--mount', '/x']});
		expect(sel.account).toBe('anonpi');
		expect(sel.name).toBe(undefined);
		expect(sel.error).toBe(undefined);
	});

	it('--as <name> resolves to the namespaced account', () => {
		const sel = resolvePersonaSelection({args: ['--as', 'alice', 'recon']});
		expect(sel.account).toBe('anonpi-alice');
		expect(sel.name).toBe('alice');
		expect(sel.error).toBe(undefined);
	});

	it('--as with no value is representable as an error for the impure layer', () => {
		const sel = resolvePersonaSelection({args: ['--as']});
		expect(sel.error).toBeInstanceOf(AnonPiError);
	});

	it('--as with a following flag (no value) is an error', () => {
		const sel = resolvePersonaSelection({args: ['--as', '--mount', '/x']});
		expect(sel.error).toBeInstanceOf(AnonPiError);
	});

	it('--as with an invalid name is an error (charset)', () => {
		const sel = resolvePersonaSelection({args: ['--as', 'Alice']});
		expect(sel.error).toBeInstanceOf(AnonPiError);
	});

	it('--as naming anonctl namespace (`anon`) is an error (disjoint namespaces)', () => {
		expect(
			resolvePersonaSelection({args: ['--as', 'anon']}).error,
		).toBeInstanceOf(AnonPiError);
		expect(
			resolvePersonaSelection({args: ['--as', 'anon-bob']}).error,
		).toBeInstanceOf(AnonPiError);
	});

	it('exposes a pure known? predicate over an INJECTED persona list', () => {
		const sel = resolvePersonaSelection({
			args: ['--as', 'alice'],
			personas: ['anonpi', 'anonpi-alice', 'anonpi-bob'],
		});
		expect(sel.account).toBe('anonpi-alice');
		expect(sel.known).toBe(true);
		expect(sel.error).toBe(undefined);
	});

	it('an UNKNOWN persona is representable as an error for the impure layer', () => {
		const sel = resolvePersonaSelection({
			args: ['--as', 'carol'],
			personas: ['anonpi', 'anonpi-alice'],
		});
		expect(sel.account).toBe('anonpi-carol');
		expect(sel.known).toBe(false);
		expect(sel.error).toBeInstanceOf(AnonPiError);
	});

	it('the default `anonpi` is known when no persona list is injected (no I/O)', () => {
		const sel = resolvePersonaSelection({args: []});
		expect(sel.account).toBe('anonpi');
		expect(sel.known).toBe(true);
		expect(sel.error).toBe(undefined);
	});

	it('the default `anonpi` is known when it is in the injected list', () => {
		const sel = resolvePersonaSelection({args: [], personas: ['anonpi']});
		expect(sel.known).toBe(true);
		expect(sel.error).toBe(undefined);
	});

	it('pins the flag token', () => {
		expect(AS_FLAG).toBe('--as');
	});

	it('yields a PersonaSelection shape', () => {
		const sel: PersonaSelection = resolvePersonaSelection({args: []});
		expect(sel.account).toBe('anonpi');
	});
});

describe('persona selection: stripAsFlag (the launch-forwarded argv netcage never sees --as)', () => {
	it('removes `--as <name>` so netcage/the launch grammar never see it', () => {
		expect(stripAsFlag(['--as', 'alice', 'recon', '--mount', '/x'])).toEqual([
			'recon',
			'--mount',
			'/x',
		]);
	});

	it('strips `--as <name>` from the MIDDLE of the argv', () => {
		expect(stripAsFlag(['recon', '--as', 'alice', '-p', 'hi'])).toEqual([
			'recon',
			'-p',
			'hi',
		]);
	});

	it('leaves an argv with no `--as` untouched', () => {
		expect(stripAsFlag(['recon', '--mount', '/x'])).toEqual([
			'recon',
			'--mount',
			'/x',
		]);
		expect(stripAsFlag([])).toEqual([]);
	});

	it('drops a trailing `--as` with no value (the impure layer errors on it first)', () => {
		expect(stripAsFlag(['recon', '--as'])).toEqual(['recon']);
	});

	it('strips only the FIRST `--as` occurrence (its value is a persona name, not a flag)', () => {
		// a second literal `--as` after a stripped one is left as an ordinary token
		// for the launch grammar to reject; selection only ever reads the first.
		expect(stripAsFlag(['--as', 'alice', '--as', 'bob'])).toEqual([
			'--as',
			'bob',
		]);
	});
});

describe('persona guard: shouldRedirectToPersona (generalized "am I the TARGET persona?")', () => {
	it('redirects on a hardened install when current != selected persona account', () => {
		expect(
			shouldRedirectToPersona({
				hardened: true,
				currentAccount: 'bob',
				selectedAccount: 'anonpi-alice',
			}),
		).toBe(true);
	});

	it('does NOT redirect when already running as the SELECTED persona (loop guard)', () => {
		expect(
			shouldRedirectToPersona({
				hardened: true,
				currentAccount: 'anonpi-alice',
				selectedAccount: 'anonpi-alice',
			}),
		).toBe(false);
	});

	it('does NOT redirect when not hardened (any identity)', () => {
		expect(
			shouldRedirectToPersona({
				hardened: false,
				currentAccount: 'bob',
				selectedAccount: 'anonpi-alice',
			}),
		).toBe(false);
	});

	it('default persona `anonpi`: the login user redirects into it', () => {
		expect(
			shouldRedirectToPersona({
				hardened: true,
				currentAccount: 'operator',
				selectedAccount: 'anonpi',
			}),
		).toBe(true);
	});

	it('already `anonpi` does not loop', () => {
		expect(
			shouldRedirectToPersona({
				hardened: true,
				currentAccount: 'anonpi',
				selectedAccount: 'anonpi',
			}),
		).toBe(false);
	});

	it('a persona is never auto-redirected to a DIFFERENT persona it already is', () => {
		// running as anonpi-bob, selected anonpi-bob -> stay (no cross-persona hop)
		expect(
			shouldRedirectToPersona({
				hardened: true,
				currentAccount: 'anonpi-bob',
				selectedAccount: 'anonpi-bob',
			}),
		).toBe(false);
	});
});
