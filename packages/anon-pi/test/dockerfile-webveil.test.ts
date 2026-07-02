import {describe, it, expect} from 'vitest';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

// Rung-1 structural test for the shipped example image
// examples/Dockerfile.pi-webveil. It does NOT build the image (that needs
// podman + network + minutes; it is a documented reference, see the file
// header). It DOES assert the load-bearing invariants that would silently break
// the topology: the embedded settings.yml / webveil.json / entrypoint are
// well-formed and consistent (http-socket not socket, limiter off, json format,
// unix: baseUrl + egress direct, entrypoint execs the passed CMD). These are the
// regressions a careless edit actually introduces.

const dockerfile = readFileSync(
	join(
		dirname(fileURLToPath(import.meta.url)),
		'..',
		'examples',
		'Dockerfile.pi-webveil',
	),
	'utf8',
);

/**
 * Extract the payload written by a `printf '%s\n' 'a' 'b' ... > <destSuffix>`
 * block. The block spans from the `printf '%s\n'` line to the `> <dest>` line;
 * each intervening content item is a single-quoted string on its own line,
 * optionally ending with a ` \` shell continuation. The quoted content may
 * itself contain backslashes (the entrypoint's uwsgi line continuations), so we
 * strip the trailing continuation FIRST, then take the content between the outer
 * single quotes.
 */
function extractPrintfBlock(text: string, destSuffix: string): string {
	const lines = text.split('\n');
	const destIdx = lines.findIndex(
		(l) => l.includes('> ') && l.includes(destSuffix),
	);
	expect(destIdx, `no printf redirection to ${destSuffix}`).toBeGreaterThan(-1);
	let startIdx = destIdx;
	while (startIdx >= 0 && !/printf '%s\\n'/.test(lines[startIdx])) startIdx--;
	expect(startIdx, `no printf start for ${destSuffix}`).toBeGreaterThan(-1);

	const out: string[] = [];
	// content items live strictly BETWEEN the printf line and the redirection line
	for (let i = startIdx + 1; i < destIdx; i++) {
		let s = lines[i];
		// strip a trailing shell line-continuation ` \`
		s = s.replace(/\s*\\\s*$/, '');
		s = s.trim();
		// take the text between the first and last single quote on the line
		const first = s.indexOf("'");
		const last = s.lastIndexOf("'");
		if (first === -1 || last <= first) continue;
		out.push(s.slice(first + 1, last));
	}
	return out.join('\n');
}

describe('examples/Dockerfile.pi-webveil structure', () => {
	it('starts FROM a node base and installs pi + pi-webveil via `pi install`', () => {
		expect(dockerfile).toMatch(/^FROM node:/m);
		expect(dockerfile).toContain('@earendil-works/pi-coding-agent');
		expect(dockerfile).toMatch(/pi install npm:pi-webveil/);
	});

	it('embeds a settings.yml with the local-instance requirements', () => {
		const yaml = extractPrintfBlock(dockerfile, '/etc/searxng/settings.yml');
		// No YAML dep in this zero-dep package: assert on the two load-bearing
		// lines directly. limiter MUST be off and json MUST be an output format,
		// else webveil gets 429 / HTML instead of JSON.
		const lines = yaml.split('\n').map((l) => l.trim());
		expect(lines).toContain('limiter: false');
		expect(yaml).toMatch(/formats:\s*\[[^\]]*\bjson\b/);
		// well-formed enough: key: value or key: on every non-empty line
		for (const l of lines) {
			if (l === '') continue;
			expect(l).toMatch(/^[A-Za-z0-9_ "-]+:( .*)?$|^- /);
		}
	});

	it('embeds a valid webveil.json: searxng over a unix: socket, egress direct', () => {
		const jsonText = extractPrintfBlock(
			dockerfile,
			'/root/.pi/agent/webveil.json',
		);
		const cfg = JSON.parse(jsonText) as {
			backend?: string;
			baseUrl?: string;
			egress?: {mode?: string};
		};
		expect(cfg.backend).toBe('searxng');
		// A unix: baseUrl avoids the loopback-TCP guard; egress direct is correct
		// in-jail (netcage anonymizes the crawl), and a NON-direct egress to a
		// unix/loopback baseUrl is exactly what webveil rejects.
		expect(cfg.baseUrl).toMatch(/^unix:/);
		expect(cfg.egress?.mode).toBe('direct');
	});

	it('serves SearXNG over http-socket (not the native uwsgi socket)', () => {
		// webveil's unix: baseUrl speaks HTTP over the socket, so uWSGI must use
		// http-socket. A bare `socket =`/`--socket ` would be the uwsgi protocol
		// webveil cannot speak.
		expect(dockerfile).toMatch(/--http-socket\s+\/run\/searxng\/socket/);
		expect(dockerfile).not.toMatch(/(^|\s)--socket\s/);
	});

	it('has an entrypoint that is valid sh and execs the passed CMD', () => {
		const script = extractPrintfBlock(
			dockerfile,
			'/usr/local/bin/anon-pi-entrypoint',
		);
		expect(script).toMatch(/^#!\/bin\/sh/);
		// The whole point: after starting SearXNG it must exec whatever anon-pi
		// passes as CMD (`sh -c 'cp ... && exec pi'`), so ENTRYPOINT + CMD compose.
		expect(script).toMatch(/exec "\$@"\s*$/);
		// it launches uwsgi before exec
		const execIdx = script.indexOf('exec "$@"');
		expect(script.slice(0, execIdx)).toContain('uwsgi');

		// Actually parse it as a shell script (stronger than a regex): `sh -n`
		// syntax-checks without executing.
		const dir = mkdtempSync(join(tmpdir(), 'anon-pi-ep-'));
		try {
			const f = join(dir, 'entrypoint.sh');
			writeFileSync(f, script);
			const r = spawnSync('sh', ['-n', f], {encoding: 'utf8'});
			expect(r.status, `sh -n failed: ${r.stderr}`).toBe(0);
		} finally {
			rmSync(dir, {recursive: true, force: true});
		}
	});

	it('wires the ENTRYPOINT to that script (so it is honored, CMD is appended)', () => {
		expect(dockerfile).toMatch(
			/ENTRYPOINT\s+\["\/usr\/local\/bin\/anon-pi-entrypoint"\]/,
		);
	});

	it('pre-trusts /work so pi does not prompt on the mounted project', () => {
		expect(dockerfile).toMatch(/\/root\/\.pi\/agent\/trust\.json/);
		expect(dockerfile).toContain('"/work": true');
	});
});
