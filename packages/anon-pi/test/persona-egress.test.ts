import {describe, it, expect} from 'vitest';
import {
	AnonPiError,
	PROXY_REQUIRED_MESSAGE,
	resolveProxy,
	composeTorPersonaProxy,
	TOR_PLACEHOLDER_PASSWORD,
	DEFAULT_TOR_SOCKS_HOST_PORT,
	offerTor,
	type TorDetection,
} from '../src/index.js';

// The PURE per-persona egress composition (spec `multi-persona-hardened-accounts`,
// decisions 3 + 4 + 5, superseding ADR-0006). Three pieces, all pure + injected:
// the Tor multi-persona URL composer (account name AS the SOCKS-isolation
// username), the "offer Tor?" predicate over an INJECTED Tor-detection probe, and
// the per-persona fail-closed guarantee (reuse of v1's PROXY_REQUIRED_MESSAGE, no
// fallback across personas). No real Tor/socket/netcage here.

describe('per-persona egress: composeTorPersonaProxy (account -> socks5h://<account>:x@<host:port>)', () => {
	it('composes the literal Tor URL with the account as the SOCKS-isolation username', () => {
		expect(composeTorPersonaProxy('anonpi-alice')).toBe(
			'socks5h://anonpi-alice:x@127.0.0.1:9050',
		);
	});

	it('uses the default persona account `anonpi` as the isolation username too', () => {
		expect(composeTorPersonaProxy('anonpi')).toBe(
			'socks5h://anonpi:x@127.0.0.1:9050',
		);
	});

	it('gives two personas DISTINCT isolation usernames on the same Tor endpoint', () => {
		// Same :9050, different username -> Tor IsolateSOCKSAuth gives separate
		// circuits/exits. The composer is what makes the usernames distinct.
		const a = composeTorPersonaProxy('anonpi-alice');
		const b = composeTorPersonaProxy('anonpi-bob');
		expect(a).not.toBe(b);
		expect(a).toContain('anonpi-alice:x@');
		expect(b).toContain('anonpi-bob:x@');
	});

	it('defaults the host:port to 127.0.0.1:9050 (system Tor)', () => {
		expect(DEFAULT_TOR_SOCKS_HOST_PORT).toBe('127.0.0.1:9050');
		expect(composeTorPersonaProxy('anonpi-alice')).toContain('@127.0.0.1:9050');
	});

	it('accepts a custom Tor SOCKS host:port', () => {
		expect(composeTorPersonaProxy('anonpi-alice', '127.0.0.1:9150')).toBe(
			'socks5h://anonpi-alice:x@127.0.0.1:9150',
		);
		expect(composeTorPersonaProxy('anonpi-bob', '10.0.0.2:9050')).toBe(
			'socks5h://anonpi-bob:x@10.0.0.2:9050',
		);
	});

	it('normalises a custom host:port that carries a scheme (never socks5h://socks5h://)', () => {
		expect(
			composeTorPersonaProxy('anonpi-alice', 'socks5h://127.0.0.1:9050'),
		).toBe('socks5h://anonpi-alice:x@127.0.0.1:9050');
	});

	it('uses the ignored placeholder password `x`', () => {
		expect(TOR_PLACEHOLDER_PASSWORD).toBe('x');
		expect(composeTorPersonaProxy('anonpi-alice')).toContain(':x@');
	});

	it('produces a plain literal socks5h URL, readable as an ordinary v1 proxy', () => {
		// The composed URL is stored in the persona config `proxy` field verbatim;
		// it must be a bare socks5h:// string with no schema marker.
		const url = composeTorPersonaProxy('anonpi-alice');
		expect(url.startsWith('socks5h://')).toBe(true);
		// It round-trips as an ordinary v1 proxy (resolveProxy returns it unchanged).
		expect(resolveProxy({config: {proxy: url}, env: {}})).toBe(url);
	});

	it('rejects an empty account (there is no isolation username to inject)', () => {
		expect(() => composeTorPersonaProxy('')).toThrow(AnonPiError);
		expect(() => composeTorPersonaProxy('   ')).toThrow(AnonPiError);
	});
});

describe('per-persona egress: offerTor (pure predicate over an INJECTED Tor-detection probe)', () => {
	it('offers Tor when the injected probe reports a running SOCKS5 Tor', () => {
		const detection: TorDetection = {open: true, socks5: true};
		expect(offerTor(detection)).toBe(true);
	});

	it('does NOT offer Tor when the port is closed', () => {
		expect(offerTor({open: false, socks5: false})).toBe(false);
		expect(offerTor({open: false})).toBe(false);
	});

	it('does NOT offer Tor when the port is open but does NOT speak SOCKS5', () => {
		expect(offerTor({open: true, socks5: false})).toBe(false);
	});

	it('does NOT offer Tor when no detection was performed (undefined probe result)', () => {
		expect(offerTor(undefined)).toBe(false);
	});

	it('is pure: it decides only over the injected result (no socket/netcage call)', () => {
		// Two calls with the same input give the same output; nothing observable
		// changes. (There is no real probe to mock: the probe is the injected arg.)
		const detection: TorDetection = {open: true, socks5: true};
		expect(offerTor(detection)).toBe(offerTor(detection));
	});
});

describe('per-persona egress: fail-closed per persona (reuse of v1 PROXY_REQUIRED_MESSAGE, no cross-persona fallback)', () => {
	it('a persona with no resolvable proxy refuses byte-identically to v1', () => {
		// The persona re-exec means resolveProxy reads THIS persona's own config;
		// an empty config for the persona must fail closed exactly as v1 does.
		let msg = '';
		try {
			resolveProxy({config: {}, env: {}});
		} catch (e) {
			expect(e).toBeInstanceOf(AnonPiError);
			msg = (e as Error).message;
		}
		expect(msg).toBe(PROXY_REQUIRED_MESSAGE);
	});

	it('never falls back to another persona: alice with no proxy does not inherit bob', () => {
		// bob's composed Tor URL exists, but alice's own (empty) config must NOT see
		// it. The pure resolver only ever reads the config it is handed, so a
		// persona whose OWN config lacks a proxy fails closed regardless of any
		// other persona's proxy.
		const bobProxy = composeTorPersonaProxy('anonpi-bob');
		expect(bobProxy).toBe('socks5h://anonpi-bob:x@127.0.0.1:9050');
		// alice resolves over her OWN (empty) config -> fail-closed, not bob's proxy.
		expect(() => resolveProxy({config: {}, env: {}})).toThrow(AnonPiError);
	});

	it('a persona WITH its own composed Tor proxy resolves to exactly that proxy', () => {
		const aliceProxy = composeTorPersonaProxy('anonpi-alice');
		expect(resolveProxy({config: {proxy: aliceProxy}, env: {}})).toBe(
			aliceProxy,
		);
	});

	it('a BYO persona resolves to its own literal socks5h endpoint', () => {
		// Bring-your-own: a plain socks5h URL (no isolation username) stored in the
		// persona config resolves unchanged, still fail-closed if absent.
		const byo = 'socks5h://127.0.0.1:1080';
		expect(resolveProxy({config: {proxy: byo}, env: {}})).toBe(byo);
	});
});
