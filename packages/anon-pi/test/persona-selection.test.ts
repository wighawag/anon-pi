import {describe, it, expect} from 'vitest';
import {
	ANON_ACCOUNT,
	PERSONA_ACCOUNT_PREFIX,
	AS_FLAG,
	AnonPiError,
	personaAccount,
	personaName,
	validatePersonaName,
	resolvePersonaSelection,
	shouldRedirectToPersona,
	stripAsFlag,
	type PersonaSelection,
} from '../src/index.js';

// The PURE core that generalizes v1's single hard-coded `anon` account into N
// personas selected by a bare name (prd `multi-persona-hardened-accounts`,
// superseding ADR-0006). Three pieces, all pure + injected (mirroring the v1
// hardened surface): the name<->account mapping, the `--as` selection resolver
// over an INJECTED persona list, and the generalized self-re-exec loop guard
// ("am I the TARGET persona?"). No real sudo/whoami/fs here.

describe('persona mapping: personaAccount (bare name -> anon-<name>, default anon)', () => {
	it('maps a bare name to the namespaced account', () => {
		expect(personaAccount('alice')).toBe('anon-alice');
	});

	it('maps the default (absent / undefined) to the bare `anon`', () => {
		expect(personaAccount(undefined)).toBe(ANON_ACCOUNT);
		expect(personaAccount()).toBe(ANON_ACCOUNT);
	});

	it('maps the default (empty / whitespace-only) to the bare `anon`', () => {
		expect(personaAccount('')).toBe(ANON_ACCOUNT);
		expect(personaAccount('   ')).toBe(ANON_ACCOUNT);
	});

	it('trims surrounding whitespace before mapping', () => {
		expect(personaAccount('  alice  ')).toBe('anon-alice');
	});

	it('is byte-behaviour-identical to v1 for the default account name', () => {
		expect(personaAccount()).toBe('anon');
		expect(PERSONA_ACCOUNT_PREFIX).toBe('anon-');
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

	it('rejects a name already carrying the `anon-` prefix (double-prefix)', () => {
		expect(() => validatePersonaName('anon-alice')).toThrow(AnonPiError);
		expect(() => validatePersonaName('anon-')).toThrow(AnonPiError);
	});

	it('rejects uppercase and separators/whitespace that would break the account', () => {
		expect(() => validatePersonaName('Alice')).toThrow(AnonPiError);
		expect(() => validatePersonaName('a/b')).toThrow(AnonPiError);
		expect(() => validatePersonaName('a b')).toThrow(AnonPiError);
		expect(() => validatePersonaName('a:b')).toThrow(AnonPiError);
		expect(() => validatePersonaName('a_b')).toThrow(AnonPiError);
	});

	it('rejects a leading hyphen or a leading digit-then-nothing-odd (must start alnum)', () => {
		expect(() => validatePersonaName('-alice')).toThrow(AnonPiError);
	});

	it('personaAccount validates too (an invalid name yields a clear error)', () => {
		expect(() => personaAccount('Alice')).toThrow(AnonPiError);
		expect(() => personaAccount('anon-bob')).toThrow(AnonPiError);
	});
});

describe('persona mapping: personaName (inverse of personaAccount)', () => {
	it('maps a namespaced account back to its bare name', () => {
		expect(personaName('anon-alice')).toBe('alice');
	});

	it('maps the default account to the default (undefined bare name)', () => {
		expect(personaName('anon')).toBe(undefined);
	});

	it('returns undefined for a non-persona account', () => {
		expect(personaName('root')).toBe(undefined);
		expect(personaName('anonalice')).toBe(undefined);
	});
});

describe('persona selection: resolvePersonaSelection (--as <name>, default anon, known? over injected list)', () => {
	it('absent --as resolves to the default `anon`, no name, known by default', () => {
		const sel = resolvePersonaSelection({args: ['recon', '--mount', '/x']});
		expect(sel.account).toBe('anon');
		expect(sel.name).toBe(undefined);
		expect(sel.error).toBe(undefined);
	});

	it('--as <name> resolves to the namespaced account', () => {
		const sel = resolvePersonaSelection({args: ['--as', 'alice', 'recon']});
		expect(sel.account).toBe('anon-alice');
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

	it('exposes a pure known? predicate over an INJECTED persona list', () => {
		const sel = resolvePersonaSelection({
			args: ['--as', 'alice'],
			personas: ['anon', 'anon-alice', 'anon-bob'],
		});
		expect(sel.account).toBe('anon-alice');
		expect(sel.known).toBe(true);
		expect(sel.error).toBe(undefined);
	});

	it('an UNKNOWN persona is representable as an error for the impure layer', () => {
		const sel = resolvePersonaSelection({
			args: ['--as', 'carol'],
			personas: ['anon', 'anon-alice'],
		});
		expect(sel.account).toBe('anon-carol');
		expect(sel.known).toBe(false);
		expect(sel.error).toBeInstanceOf(AnonPiError);
	});

	it('the default `anon` is known when no persona list is injected (no I/O)', () => {
		const sel = resolvePersonaSelection({args: []});
		expect(sel.account).toBe('anon');
		expect(sel.known).toBe(true);
		expect(sel.error).toBe(undefined);
	});

	it('the default `anon` is known when it is in the injected list', () => {
		const sel = resolvePersonaSelection({args: [], personas: ['anon']});
		expect(sel.known).toBe(true);
		expect(sel.error).toBe(undefined);
	});

	it('pins the flag token', () => {
		expect(AS_FLAG).toBe('--as');
	});

	it('yields a PersonaSelection shape', () => {
		const sel: PersonaSelection = resolvePersonaSelection({args: []});
		expect(sel.account).toBe('anon');
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

	it('leaves an argv with no `--as` untouched (v1 byte-identical)', () => {
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
				selectedAccount: 'anon-alice',
			}),
		).toBe(true);
	});

	it('does NOT redirect when already running as the SELECTED persona (loop guard)', () => {
		expect(
			shouldRedirectToPersona({
				hardened: true,
				currentAccount: 'anon-alice',
				selectedAccount: 'anon-alice',
			}),
		).toBe(false);
	});

	it('does NOT redirect when not hardened (any identity)', () => {
		expect(
			shouldRedirectToPersona({
				hardened: false,
				currentAccount: 'bob',
				selectedAccount: 'anon-alice',
			}),
		).toBe(false);
	});

	it('is behaviour-preserving for v1: default persona `anon`, login user redirects', () => {
		expect(
			shouldRedirectToPersona({
				hardened: true,
				currentAccount: 'operator',
				selectedAccount: 'anon',
			}),
		).toBe(true);
	});

	it('is behaviour-preserving for v1: already `anon` does not loop', () => {
		expect(
			shouldRedirectToPersona({
				hardened: true,
				currentAccount: 'anon',
				selectedAccount: 'anon',
			}),
		).toBe(false);
	});

	it('a persona is never auto-redirected to a DIFFERENT persona it already is', () => {
		// running as anon-bob, selected anon-bob -> stay (no cross-persona hop)
		expect(
			shouldRedirectToPersona({
				hardened: true,
				currentAccount: 'anon-bob',
				selectedAccount: 'anon-bob',
			}),
		).toBe(false);
	});
});
