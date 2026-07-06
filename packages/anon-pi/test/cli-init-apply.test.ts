// End-to-end IMPURE wiring for the as-account workspace-write handoff
// (`anon-pi __init-apply`): the internal subcommand the hardened `init` /
// `persona add` crossing invokes AS the account. On a hardened install the
// login user cannot write the account's mode-700 home, so anon-pi crosses via
// `sudo -u <account> -i anon-pi __init-apply` and pipes the resolved payload on
// STDIN; the child (running as the account) writes the workspace into its OWN
// ~/.anon-pi. This exercises the child directly (no sudo): we run
// `node dist/cli.js __init-apply` with ANON_PI_HOME pointed at a temp "account"
// home and the payload on stdin, and assert the writes land there at mode 0700.
//
// Requires the package to be built (dist/cli.js); CI builds before test.
import {afterEach, describe, it, expect} from 'vitest';
import {existsSync, mkdtempSync, readFileSync, rmSync, statSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {INIT_APPLY_SUBCOMMAND, type InitApplyPayload} from '../src/index.js';

const cli = join(
	dirname(fileURLToPath(import.meta.url)),
	'..',
	'dist',
	'cli.js',
);

const scratch: string[] = [];
afterEach(() => {
	for (const d of scratch.splice(0)) rmSync(d, {recursive: true, force: true});
});

function tmp(prefix: string): string {
	const d = mkdtempSync(join(tmpdir(), prefix));
	scratch.push(d);
	return d;
}

/** Run `anon-pi __init-apply` with the payload piped on stdin, ANON_PI_HOME set. */
function apply(anonHome: string, payload: unknown) {
	return spawnSync(process.execPath, [cli, INIT_APPLY_SUBCOMMAND], {
		encoding: 'utf8',
		env: {...process.env, ANON_PI_HOME: anonHome},
		input: JSON.stringify(payload),
	});
}

describe('__init-apply: writes the workspace into ITS OWN home (the crossing target)', () => {
	it('writes config.json (mode 0700 home) + the default machine for an init payload', () => {
		const anonHome = join(tmp('anon-acct-'), '.anon-pi');
		const payload: InitApplyPayload = {
			config: {proxy: 'socks5h://127.0.0.1:9050', hardened: true},
			machine: 'default',
			machineImage: 'localhost/x:latest',
		};
		const r = apply(anonHome, payload);
		expect(r.status).toBe(0);
		expect(r.stderr).not.toContain('TRIPWIRE');
		const cfgPath = join(anonHome, 'config.json');
		expect(existsSync(cfgPath)).toBe(true);
		const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
		expect(cfg.proxy).toBe('socks5h://127.0.0.1:9050');
		expect(cfg.hardened).toBe(true);
		// hardened workspace is mode-700 (only the account may read its transcripts).
		expect(statSync(anonHome).mode & 0o777).toBe(0o700);
		// the default machine was created + pinned.
		expect(
			existsSync(join(anonHome, 'machines', 'default', 'machine.json')),
		).toBe(true);
	});

	it('a persona payload (no `machine`) writes ONLY config.json, no default machine', () => {
		const anonHome = join(tmp('anon-acct-'), '.anon-pi');
		const payload: InitApplyPayload = {
			config: {proxy: 'socks5h://anon-alice:x@127.0.0.1:9050', hardened: true},
		};
		const r = apply(anonHome, payload);
		expect(r.status).toBe(0);
		const cfg = JSON.parse(readFileSync(join(anonHome, 'config.json'), 'utf8'));
		expect(cfg.proxy).toBe('socks5h://anon-alice:x@127.0.0.1:9050');
		// NO default machine for a persona (identity/config is the user's to set).
		expect(existsSync(join(anonHome, 'machines'))).toBe(false);
	});

	it('rejects a malformed payload (no config) with a clear non-zero exit', () => {
		const anonHome = join(tmp('anon-acct-'), '.anon-pi');
		const r = apply(anonHome, {notConfig: true});
		expect(r.status).not.toBe(0);
		expect(r.stderr).toMatch(/payload is missing `config`/);
		expect(existsSync(join(anonHome, 'config.json'))).toBe(false);
	});

	it('rejects unparseable stdin with a clear non-zero exit', () => {
		const anonHome = join(tmp('anon-acct-'), '.anon-pi');
		const r = spawnSync(process.execPath, [cli, INIT_APPLY_SUBCOMMAND], {
			encoding: 'utf8',
			env: {...process.env, ANON_PI_HOME: anonHome},
			input: 'not json{',
		});
		expect(r.status).not.toBe(0);
		expect(r.stderr).toMatch(/unparseable payload/);
	});
});
