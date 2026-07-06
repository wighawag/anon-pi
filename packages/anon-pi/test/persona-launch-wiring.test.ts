// End-to-end IMPURE wiring for MULTI-PERSONA launch selection (prd
// `multi-persona-hardened-accounts`, superseding ADR-0006; task
// `persona-as-launch-selection-wiring`). Generalizes v1's single-account
// self-re-exec (hardened-wiring.test.ts) to the SELECTED persona: on a hardened
// install `anon-pi --as <name> …` re-execs into `anon-<name>` (default `anon`),
// the `--as` value is STRIPPED from the argv netcage sees yet SURVIVES into the
// re-exec, an unknown persona errors, and the no-`--as` default stays
// byte-identical to v1.
//
// ISOLATION (the task's hard constraint): every OS-touching bit is stubbed. We
// point ANON_PI_HOME at a TEMP dir and PATH at a temp bin holding a FAKE `sudo`
// that RECORDS its argv and a FAKE `getent` that answers the account-existence
// probe from an allow-list (never a real passwd lookup). Tripwire fakes for
// `su`/`podman`/`netcage`/`loginctl` fail LOUDLY if the redirect ever shells out
// to them (the crossing must be a plain sudo spawn; netcage must never see
// `--as`). We assert the real `~/.anon-pi` mtime is unchanged. No real
// sudo/su/podman/netcage/loginctl/getent ever runs. The "already the selected
// persona" loop guard is covered at the pure seam (shouldRedirectToPersona) in
// persona-selection.test.ts, since a test cannot change the real uid.
//
// Requires the package to be built (dist/cli.js); CI builds before test.
import {afterEach, describe, it, expect} from 'vitest';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {homedir, tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

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

/**
 * A temp bin dir on PATH. `sudo` records its argv to a log file and exits 0
 * WITHOUT running anything real. `getent passwd <account>` answers from an
 * ALLOW-LIST of accounts (the `existingAccounts`); a hit prints a passwd line
 * (so the account-home lookup / existence probe resolves), a miss exits 2 (the
 * account does not exist). The other tools are TRIPWIRES: if the redirect ever
 * invokes them the test fails (the crossing must be a plain sudo spawn, and
 * netcage must never see `--as`).
 */
function fakeBin(sudoLog: string, existingAccounts: string[]): string {
	const bin = tmp('anon-pi-bin-');
	writeFileSync(
		join(bin, 'sudo'),
		`#!/bin/sh\nprintf '%s\\n' "$@" >>'${sudoLog}'\nexit 0\n`,
	);
	// getent passwd <account>: hit -> a passwd line with a temp home; miss -> exit 2.
	const cases = existingAccounts
		.map(
			(acct) =>
				`  ${acct}) printf '%s:x:4242:4242::/tmp/${acct}-home:/bin/sh\\n' ; exit 0 ;;`,
		)
		.join('\n');
	writeFileSync(
		join(bin, 'getent'),
		`#!/bin/sh\n# only answers \`getent passwd <account>\`\nif [ "$1" = passwd ]; then\n  case "$2" in\n${cases}\n  *) exit 2 ;;\n  esac\nfi\nexit 2\n`,
	);
	for (const tripwire of ['su', 'podman', 'netcage', 'loginctl']) {
		writeFileSync(
			join(bin, tripwire),
			`#!/bin/sh\necho "TRIPWIRE: real ${tripwire} was invoked" >&2\nexit 97\n`,
		);
	}
	for (const f of ['sudo', 'getent', 'su', 'podman', 'netcage', 'loginctl']) {
		chmodSync(join(bin, f), 0o755);
	}
	return bin;
}

function writeHardenedConfig(home: string, hardened: boolean) {
	mkdirSync(home, {recursive: true});
	writeFileSync(
		join(home, 'config.json'),
		JSON.stringify(
			{
				proxy: 'socks5h://127.0.0.1:9050',
				llm: '192.168.1.150:8080',
				defaultMachine: 'default',
				...(hardened ? {hardened: true} : {}),
			},
			null,
			'\t',
		) + '\n',
	);
}

/** Run the built CLI with a stubbed PATH + temp home. */
function run(args: string[], opts: {home: string; bin: string}) {
	return spawnSync(process.execPath, [cli, ...args], {
		encoding: 'utf8',
		env: {
			...process.env,
			PATH: `${opts.bin}:${process.env.PATH ?? ''}`,
			ANON_PI_HOME: opts.home,
		},
	});
}

describe('multi-persona launch: `--as <name>` selects + re-execs into the persona account', () => {
	it('redirects `--as alice` into `sudo -u anon-alice -i …`, --as SURVIVING the re-exec', () => {
		const home = tmp('anon-pi-home-');
		writeHardenedConfig(home, true);
		const sudoLog = join(tmp('anon-pi-log-'), 'sudo.log');
		// anon-alice exists (was provisioned by `persona add`); the default anon too.
		const bin = fakeBin(sudoLog, ['anon', 'anon-alice']);

		const r = run(['--as', 'alice', 'recon', '--mount', '/tmp/x'], {home, bin});
		expect(r.status).toBe(0);
		expect(existsSync(sudoLog)).toBe(true);
		const argv = readFileSync(sudoLog, 'utf8').trim().split('\n');
		// sudo saw: -u anon-alice -i <anon-pi> --as alice recon --mount /tmp/x
		expect(argv.slice(0, 3)).toEqual(['-u', 'anon-alice', '-i']);
		// the 4th arg is the anon-pi binary path; then the forwarded args verbatim,
		// with `--as alice` PRESERVED so the child re-derives its persona + loop-guards.
		expect(argv.slice(4)).toEqual([
			'--as',
			'alice',
			'recon',
			'--mount',
			'/tmp/x',
		]);
	});

	it('no `--as` (default persona) redirects into `anon` exactly as v1', () => {
		const home = tmp('anon-pi-home-');
		writeHardenedConfig(home, true);
		const sudoLog = join(tmp('anon-pi-log-'), 'sudo.log');
		const bin = fakeBin(sudoLog, ['anon']);

		const r = run(['recon', '--mount', '/tmp/x'], {home, bin});
		expect(r.status).toBe(0);
		const argv = readFileSync(sudoLog, 'utf8').trim().split('\n');
		// byte-identical to v1's hardened-wiring test: -u anon -i <anon-pi> recon …
		expect(argv.slice(0, 3)).toEqual(['-u', 'anon', '-i']);
		expect(argv.slice(4)).toEqual(['recon', '--mount', '/tmp/x']);
		// the default path carries NO `--as` token into the re-exec.
		expect(argv).not.toContain('--as');
	});

	it('an UNKNOWN persona errors clearly (no silent create, no fall-through to anon, no sudo)', () => {
		const home = tmp('anon-pi-home-');
		writeHardenedConfig(home, true);
		const sudoLog = join(tmp('anon-pi-log-'), 'sudo.log');
		// carol was never provisioned: getent misses -> unknown-persona error.
		const bin = fakeBin(sudoLog, ['anon', 'anon-alice']);

		const r = run(['--as', 'carol', 'recon'], {home, bin});
		expect(r.status).not.toBe(0);
		expect(r.stderr).toContain('no persona');
		expect(r.stderr).toContain('carol');
		expect(r.stderr).toContain('persona add');
		// it must NOT silently redirect to anon or anywhere.
		expect(existsSync(sudoLog)).toBe(false);
	});

	it('a `--as` with no value errors (before any redirect / sudo)', () => {
		const home = tmp('anon-pi-home-');
		writeHardenedConfig(home, true);
		const sudoLog = join(tmp('anon-pi-log-'), 'sudo.log');
		const bin = fakeBin(sudoLog, ['anon']);

		const r = run(['--as'], {home, bin});
		expect(r.status).not.toBe(0);
		expect(r.stderr).toContain('--as');
		expect(existsSync(sudoLog)).toBe(false);
	});

	it('an INVALID persona name errors (charset), before any redirect / sudo', () => {
		const home = tmp('anon-pi-home-');
		writeHardenedConfig(home, true);
		const sudoLog = join(tmp('anon-pi-log-'), 'sudo.log');
		const bin = fakeBin(sudoLog, ['anon']);

		const r = run(['--as', 'Alice', 'recon'], {home, bin});
		expect(r.status).not.toBe(0);
		expect(r.stderr).toContain('persona name');
		expect(existsSync(sudoLog)).toBe(false);
	});

	it('`--version` stays local even with `--as` present (no redirect, no sudo)', () => {
		const home = tmp('anon-pi-home-');
		writeHardenedConfig(home, true);
		const sudoLog = join(tmp('anon-pi-log-'), 'sudo.log');
		const bin = fakeBin(sudoLog, ['anon', 'anon-alice']);

		const r = run(['--version'], {home, bin});
		expect(r.status).toBe(0);
		expect(r.stdout).toContain('anon-pi');
		expect(existsSync(sudoLog)).toBe(false);
	});

	it('redirects a SUBCOMMAND `--as alice machine list` into the persona (before workspace touch)', () => {
		const home = tmp('anon-pi-home-');
		writeHardenedConfig(home, true);
		const sudoLog = join(tmp('anon-pi-log-'), 'sudo.log');
		const bin = fakeBin(sudoLog, ['anon', 'anon-alice']);

		const r = run(['--as', 'alice', 'machine', 'list'], {home, bin});
		expect(r.status).toBe(0);
		const argv = readFileSync(sudoLog, 'utf8').trim().split('\n');
		expect(argv.slice(0, 3)).toEqual(['-u', 'anon-alice', '-i']);
		expect(argv.slice(4)).toEqual(['--as', 'alice', 'machine', 'list']);
	});
});

describe('multi-persona launch isolation: the redirect never touches real homes or real tools', () => {
	it('leaves the real ~/.anon-pi untouched and invokes only the fake sudo', () => {
		const realHome = join(homedir(), '.anon-pi');
		const before = existsSync(realHome) ? statSync(realHome).mtimeMs : null;

		const home = tmp('anon-pi-home-');
		writeHardenedConfig(home, true);
		const sudoLog = join(tmp('anon-pi-log-'), 'sudo.log');
		const bin = fakeBin(sudoLog, ['anon', 'anon-alice']);

		const r = run(['--as', 'alice', 'recon'], {home, bin});
		expect(r.status).toBe(0);
		expect(r.stderr).not.toContain('TRIPWIRE');

		const after = existsSync(realHome) ? statSync(realHome).mtimeMs : null;
		expect(after).toBe(before);
	});
});
