// The PURE proxy-detect / verify DECISIONS of `anon-pi init`: the SOCKS5
// handshake interpretation, the weak process hints, the findings formatter (and
// its HARD never-label-the-provider invariant), the socks5h URL, the `netcage
// verify` exit-IP parse, the image menu, and the config.json serialiser.
//
// PURE (no spawn/fs/socket): bytes/findings/strings in -> verdict/string out.
// The socket probes, the `netcage verify` / `podman build` spawns, and the
// prompts are cli.ts's thin I/O (their end-to-end shape is cli-init.test.ts).
//
// The load-bearing HONESTY constraint (this is an anonymity tool): the findings
// display NEVER claims/labels the exit provider. `never labels a provider`
// below is that constraint as an executable assertion.
import {describe, it, expect} from 'vitest';
import {
	DEFAULT_SOCKS_PROBE_PORTS,
	FORBIDDEN_PROVIDER_LABELS,
	SOCKS5_METHOD_SELECTOR,
	formatProxyFindings,
	initImageMenu,
	interpretSocks5Handshake,
	parseVerifyExitIp,
	processHint,
	serializeConfigJson,
	socks5hUrl,
	type ProxyFinding,
} from '../src/index.js';

describe('SOCKS5_METHOD_SELECTOR + DEFAULT_SOCKS_PROBE_PORTS', () => {
	it('the greeting is the RFC1928 no-auth method-selection [0x05,0x01,0x00]', () => {
		expect([...SOCKS5_METHOD_SELECTOR]).toEqual([0x05, 0x01, 0x00]);
	});

	it('probes 9050 (Tor), 9150 (Tor Browser), and 1080 (generic SOCKS)', () => {
		const ports = DEFAULT_SOCKS_PROBE_PORTS.map((p) => p.port);
		expect(ports).toEqual([9050, 9150, 1080]);
	});

	it('the 1080 hint stays provider-agnostic (never a VPN brand)', () => {
		const p1080 = DEFAULT_SOCKS_PROBE_PORTS.find((p) => p.port === 1080)!;
		const hint = p1080.hint.toLowerCase();
		for (const label of FORBIDDEN_PROVIDER_LABELS) {
			expect(hint.includes(label)).toBe(false);
		}
	});
});

describe('interpretSocks5Handshake', () => {
	it('accepts a well-formed [0x05, method] reply as SOCKS5', () => {
		expect(interpretSocks5Handshake([0x05, 0x00])).toEqual({
			socks5: true,
			method: 0x00,
		});
	});

	it('accepts a Buffer/Uint8Array reply too', () => {
		expect(interpretSocks5Handshake(Buffer.from([0x05, 0x02]))).toEqual({
			socks5: true,
			method: 0x02,
		});
		expect(interpretSocks5Handshake(Uint8Array.from([0x05, 0x00]))).toEqual({
			socks5: true,
			method: 0x00,
		});
	});

	it('rejects an empty reply (no reply)', () => {
		const r = interpretSocks5Handshake([]);
		expect(r.socks5).toBe(false);
	});

	it('rejects a short one-byte reply', () => {
		const r = interpretSocks5Handshake([0x05]);
		expect(r.socks5).toBe(false);
	});

	it('rejects a non-version-5 first byte (e.g. an HTTP proxy)', () => {
		// 'H' (0x48) as from an HTTP server: not SOCKS5.
		const r = interpretSocks5Handshake([0x48, 0x54]);
		expect(r.socks5).toBe(false);
		if (!r.socks5) expect(r.reason).toContain('not SOCKS5');
	});

	it('treats 0xff (no acceptable auth) as a soft NON-match', () => {
		const r = interpretSocks5Handshake([0x05, 0xff]);
		expect(r.socks5).toBe(false);
	});
});

describe('processHint (weak local hints; never the exit provider)', () => {
	it('maps a `tor` process to a hedged "likely Tor" hint', () => {
		const h = processHint('tor');
		expect(h).toBeDefined();
		expect(h!.hint.toLowerCase()).toContain('likely tor');
	});

	it('maps `wireproxy` to a provider-AGNOSTIC front-end hint', () => {
		const h = processHint('wireproxy');
		expect(h).toBeDefined();
		const hint = h!.hint.toLowerCase();
		expect(hint).toContain('wireguard');
		// never names WHICH VPN.
		for (const label of FORBIDDEN_PROVIDER_LABELS) {
			expect(hint.includes(label)).toBe(false);
		}
	});

	it('returns undefined for an empty or unknown process', () => {
		expect(processHint('')).toBeUndefined();
		expect(processHint('   ')).toBeUndefined();
		expect(processHint('sshd')).toBeUndefined();
	});
});

describe('formatProxyFindings', () => {
	it('renders the host:port, open state, handshake verdict, and hints', () => {
		const out = formatProxyFindings([
			{
				host: '127.0.0.1',
				port: 9050,
				open: true,
				handshake: {socks5: true, method: 0},
				portHint: 'Tor default (system tor)',
				processHint: 'a `tor` process is running -> likely Tor',
			},
		]);
		expect(out).toContain('127.0.0.1:9050');
		expect(out).toContain('SOCKS5 handshake OK');
		expect(out).toContain('likely Tor');
	});

	it('marks an open-but-not-SOCKS5 port with the reason', () => {
		const out = formatProxyFindings([
			{
				host: '127.0.0.1',
				port: 8080,
				open: true,
				handshake: {socks5: false, reason: 'not SOCKS5'},
			},
		]);
		expect(out).toContain('NOT SOCKS5');
		expect(out).toContain('not SOCKS5');
	});

	it('marks a closed port', () => {
		const out = formatProxyFindings([
			{host: '127.0.0.1', port: 9150, open: false},
		]);
		expect(out.toLowerCase()).toContain('closed');
	});

	it('handles an empty findings set with a fall-back prompt', () => {
		const out = formatProxyFindings([]);
		expect(out.toLowerCase()).toContain('host:port');
	});

	it('shows the HOST-WIDE process note ONCE, not glued onto every port', () => {
		const out = formatProxyFindings(
			[
				{host: '127.0.0.1', port: 9050, open: false},
				{host: '127.0.0.1', port: 9150, open: false},
				{
					host: '127.0.0.1',
					port: 1080,
					open: true,
					handshake: {socks5: true, method: 0},
					portHint: 'generic SOCKS (wireproxy / ssh -D)',
				},
			],
			'a `tor` process is running -> likely Tor',
		);
		// the note appears exactly once (as a general Note line), not per port.
		const occurrences = out.split('a `tor` process is running').length - 1;
		expect(occurrences).toBe(1);
		expect(out).toContain('Note: a `tor` process is running -> likely Tor');
		// closed ports carry no process hint noise.
		expect(out).toContain('127.0.0.1:9050: closed');
	});

	it('omits the host-wide process note when there is none', () => {
		const out = formatProxyFindings(
			[{host: '127.0.0.1', port: 1080, open: true}],
			undefined,
		);
		expect(out).not.toContain('Note:');
	});

	// THE HARD HONESTY INVARIANT: no matter what a probe found (even a crafted
	// process/hint containing a brand), the formatter NEVER emits an exit-provider
	// label. This is the executable half of the never-label-the-provider rule.
	it('NEVER emits a provider label, for any input', () => {
		const adversarial: ProxyFinding[] = [
			{
				host: '127.0.0.1',
				port: 1080,
				open: true,
				handshake: {socks5: true, method: 0},
				portHint: 'generic SOCKS (wireproxy / ssh -D)',
				// even if some upstream ever tried to smuggle a brand into a hint,
				// the formatter's OUTPUT must not carry it. (It just echoes fields,
				// so this asserts the fields it renders are provider-free by design.)
				processHint: 'a `wireproxy` process is running',
			},
			{host: '127.0.0.1', port: 9050, open: false},
			{
				host: '127.0.0.1',
				port: 9150,
				open: true,
				handshake: {
					socks5: false,
					reason: 'SOCKS5 but no acceptable auth method',
				},
			},
		];
		const out = formatProxyFindings(adversarial).toLowerCase();
		for (const label of FORBIDDEN_PROVIDER_LABELS) {
			expect(out.includes(label)).toBe(false);
		}
		// and the standard single-finding render is also clean.
		const std = formatProxyFindings([
			{
				host: '127.0.0.1',
				port: 9050,
				open: true,
				handshake: {socks5: true, method: 0},
				portHint: DEFAULT_SOCKS_PROBE_PORTS[0].hint,
				processHint: processHint('tor')!.hint,
			},
		]).toLowerCase();
		for (const label of FORBIDDEN_PROVIDER_LABELS) {
			expect(std.includes(label)).toBe(false);
		}
	});
});

describe('socks5hUrl', () => {
	it('wraps a bare host:port as socks5h://', () => {
		expect(socks5hUrl('127.0.0.1:9050')).toBe('socks5h://127.0.0.1:9050');
	});

	it('normalises an already-schemed value (no double scheme)', () => {
		expect(socks5hUrl('socks5://127.0.0.1:1080')).toBe(
			'socks5h://127.0.0.1:1080',
		);
		expect(socks5hUrl('socks5h://127.0.0.1:1080')).toBe(
			'socks5h://127.0.0.1:1080',
		);
	});
});

describe('parseVerifyExitIp', () => {
	it('extracts an IPv4 exit IP from netcage verify output', () => {
		const out = 'jail exit IP: 203.0.113.7\nforced egress verified\n';
		expect(parseVerifyExitIp(out)).toBe('203.0.113.7');
	});

	it('returns undefined when there is no IP in the output', () => {
		expect(parseVerifyExitIp('verify failed: offline?')).toBeUndefined();
	});

	it('ignores octets > 255 (not a valid IPv4)', () => {
		expect(parseVerifyExitIp('code 999.1.1.1 nope')).toBeUndefined();
	});

	it('extracts an IPv6 exit IP', () => {
		expect(parseVerifyExitIp('exit IP 2001:db8::1 ok')).toBe('2001:db8::1');
	});

	// REGRESSION (field bug, anon-pi@0.21.0): netcage verify prints the proxy
	// URL on the FIRST line (`proxy: socks5h://127.0.0.1:9050`), so a naive
	// first-IPv4 scrape returned the loopback PROXY address, not the exit IP,
	// scaring users into thinking anonymization was broken. The proxy line's IP
	// must be SKIPPED; the real exit IP is in the forced-egress assertion.
	it('skips the proxy line and returns the real jail exit IP (loopback proxy)', () => {
		const out =
			'proxy: socks5h://127.0.0.1:9050 (source: flag)\n' +
			'[PASS] forced-egress-exit-ip-differs-from-host: jail exit IP 203.0.113.7 differs from host 198.51.100.4 (forced egress active)\n' +
			'[PASS] dns-resolves-via-proxy\n';
		expect(parseVerifyExitIp(out)).toBe('203.0.113.7');
	});

	it('skips the proxy line even when the exit IP is also loopback-adjacent text', () => {
		// only the proxy line carries an IP (verify otherwise failed to get an
		// exit IP): we must NOT report the proxy loopback as the exit IP.
		const out =
			'proxy: socks5h://127.0.0.1:9050\n' +
			'[FAIL] forced-egress-exit-ip-differs-from-host: jail produced no exit IP\n';
		expect(parseVerifyExitIp(out)).toBeUndefined();
	});
});

describe('initImageMenu', () => {
	it('offers basic / webveil / existing / skip in order', () => {
		expect(initImageMenu().map((e) => e.choice)).toEqual([
			'basic',
			'webveil',
			'existing',
			'skip',
		]);
	});

	it('labels the shipped Dockerfiles', () => {
		const menu = initImageMenu();
		expect(menu[0].label).toContain('Dockerfile.pi');
		expect(menu[1].label).toContain('Dockerfile.pi-webveil');
	});
});

describe('serializeConfigJson', () => {
	it('writes proxy + llm + defaultMachine, tab-indented with a trailing newline', () => {
		const s = serializeConfigJson({
			proxy: 'socks5h://127.0.0.1:9050',
			llm: '192.168.1.150:8080',
			defaultMachine: 'default',
		});
		expect(JSON.parse(s)).toEqual({
			proxy: 'socks5h://127.0.0.1:9050',
			llm: '192.168.1.150:8080',
			defaultMachine: 'default',
		});
		expect(s.endsWith('}\n')).toBe(true);
		expect(s).toContain('\t"proxy"');
	});

	it('omits an empty/whitespace llm and defaultMachine (never writes "")', () => {
		const parsed = JSON.parse(
			serializeConfigJson({
				proxy: 'socks5h://127.0.0.1:9050',
				llm: '  ',
				defaultMachine: '',
			}),
		);
		expect(parsed).toEqual({proxy: 'socks5h://127.0.0.1:9050'});
	});

	it('trims field values', () => {
		const parsed = JSON.parse(
			serializeConfigJson({proxy: ' socks5h://x:1 ', llm: ' y:2 '}),
		);
		expect(parsed).toEqual({proxy: 'socks5h://x:1', llm: 'y:2'});
	});

	it('writes `hardened: true` only when hardened; omits it otherwise (docs/adr/0006)', () => {
		const hardened = JSON.parse(
			serializeConfigJson({proxy: 'socks5h://x:1', hardened: true}),
		);
		expect(hardened).toEqual({proxy: 'socks5h://x:1', hardened: true});
		// a normal install keeps config.json clean (no `hardened` key).
		expect(
			serializeConfigJson({proxy: 'socks5h://x:1', hardened: false}),
		).not.toContain('hardened');
		expect(serializeConfigJson({proxy: 'socks5h://x:1'})).not.toContain(
			'hardened',
		);
	});
});
