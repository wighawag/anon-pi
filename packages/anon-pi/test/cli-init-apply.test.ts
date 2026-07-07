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
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
	INIT_APPLY_SUBCOMMAND,
	IMAGE_EXISTS_SUBCOMMAND,
	IMAGE_BUILD_SUBCOMMAND,
	READ_CONFIG_SUBCOMMAND,
	type InitApplyPayload,
} from '../src/index.js';

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

/**
 * A temp bin dir on PATH holding a FAKE `netcage` whose `images --format json`
 * reports the given tags, `--version` answers 0.11.0, and everything else (incl.
 * `build`) is a tripwire (we only assert the exists-check dispatch here).
 */
function fakeNetcageBin(tags: string[]): string {
	const bin = tmp('anon-pi-bin-');
	const images = JSON.stringify(tags.map((t) => ({Id: t, Names: [t]})));
	writeFileSync(
		join(bin, 'netcage'),
		`#!/bin/sh\n` +
			`if [ "$1" = images ]; then printf '%s' '${images}'; exit 0; fi\n` +
			`if [ "$1" = --version ]; then echo 'netcage 0.11.0'; exit 0; fi\n` +
			`echo "TRIPWIRE: netcage $1" >&2; exit 97\n`,
	);
	chmodSync(join(bin, 'netcage'), 0o755);
	return bin;
}

/** Run an internal image subcommand with a stubbed PATH (fake netcage). */
function imageCmd(sub: string, arg: string | undefined, bin: string) {
	const args = arg === undefined ? [cli, sub] : [cli, sub, arg];
	return spawnSync(process.execPath, args, {
		encoding: 'utf8',
		env: {...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`},
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
			config: {
				proxy: 'socks5h://anonpi-alice:x@127.0.0.1:9050',
				hardened: true,
			},
		};
		const r = apply(anonHome, payload);
		expect(r.status).toBe(0);
		const cfg = JSON.parse(readFileSync(join(anonHome, 'config.json'), 'utf8'));
		expect(cfg.proxy).toBe('socks5h://anonpi-alice:x@127.0.0.1:9050');
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

describe('__image-exists / __image-build: dispatched, not treated as a project', () => {
	it('__image-exists exits 0 when the tag is in this store, 1 when not', () => {
		const tag = 'localhost/anon-pi/pi-webveil:latest';
		const present = imageCmd(
			IMAGE_EXISTS_SUBCOMMAND,
			tag,
			fakeNetcageBin([tag]),
		);
		expect(present.status).toBe(0);
		const absent = imageCmd(
			IMAGE_EXISTS_SUBCOMMAND,
			tag,
			fakeNetcageBin(['localhost/other:latest']),
		);
		expect(absent.status).toBe(1);
	});

	it('__image-exists with no tag errors (exit 2)', () => {
		const r = imageCmd(IMAGE_EXISTS_SUBCOMMAND, undefined, fakeNetcageBin([]));
		expect(r.status).toBe(2);
		expect(r.stderr).toMatch(/needs an image tag/);
	});

	it('__image-build rejects a bad choice (exit 2), never runs netcage', () => {
		const r = imageCmd(IMAGE_BUILD_SUBCOMMAND, 'bogus', fakeNetcageBin([]));
		expect(r.status).toBe(2);
		expect(r.stderr).toMatch(/takes `basic` or `webveil`/);
		expect(r.stderr).not.toContain('TRIPWIRE');
	});
});

describe('__read-config: prints THIS account config for the login-side init defaults', () => {
	it('prints the config.json from its own ANON_PI_HOME as JSON', () => {
		const anonHome = join(tmp('anon-acct-'), '.anon-pi');
		// seed a config the way the account would have.
		apply(anonHome, {
			config: {
				proxy: 'socks5h://127.0.0.1:9050',
				projects: '/home/anonpi/work',
				hardened: true,
			},
		});
		const r = spawnSync(process.execPath, [cli, READ_CONFIG_SUBCOMMAND], {
			encoding: 'utf8',
			env: {...process.env, ANON_PI_HOME: anonHome},
		});
		expect(r.status).toBe(0);
		const cfg = JSON.parse(r.stdout);
		expect(cfg.proxy).toBe('socks5h://127.0.0.1:9050');
		expect(cfg.projects).toBe('/home/anonpi/work');
		expect(cfg.hardened).toBe(true);
	});

	it('prints {} when there is no config yet', () => {
		const anonHome = join(tmp('anon-acct-'), '.anon-pi');
		const r = spawnSync(process.execPath, [cli, READ_CONFIG_SUBCOMMAND], {
			encoding: 'utf8',
			env: {...process.env, ANON_PI_HOME: anonHome},
		});
		expect(r.status).toBe(0);
		expect(JSON.parse(r.stdout)).toEqual({});
	});
});
