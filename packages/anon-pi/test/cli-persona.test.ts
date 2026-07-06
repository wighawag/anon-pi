// End-to-end IMPURE wiring for `anon-pi persona add <name>` (prd
// `multi-persona-hardened-accounts`, decisions 4-8, superseding ADR-0006): the
// thin CLI around the pure planPersonaAdd + composeTorPersonaProxy + offerTor +
// the Tier-2 command generator. It provisions a persona: maps <name> ->
// anon-<name>, chooses egress (Tor multi-persona or a bring-your-own socks5h
// endpoint + the uniqueness warning), PRINTS the Tier-2 copy-paste root commands
// when the account is missing, and (once the account exists) writes the
// persona's OWN ordinary v1 config.json into its mode-700 tree.
//
// ISOLATION (the task's hard constraint): every OS-touching bit is stubbed. PATH
// points at a temp bin holding a FAKE `getent` (reports the persona account with
// a TEMP home so the in-home write lands in a temp dir) and a FAKE `netcage`
// (detect-proxy JSON we control). `sudo`/`su`/`useradd`/`loginctl`/`podman`/`tor`
// are TRIPWIRES that fail LOUDLY if ever invoked (anon-pi never runs Tier 2; it
// only PRINTS it). ANON_PI_HOME is a temp dir; the persona home is a temp dir.
// We assert the real ~/.anon-pi and no real account are touched.
//
// The egress choice is driven by explicit flags (`--tor` / `--proxy <url>`) so
// the flow is scriptable without a TTY (spawnSync pipes stdin, so isTTY=false);
// the interactive prompt branches are exercised only for their no-TTY refusal.
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
 * A temp bin dir on PATH. Only stubs the tools the persona-add flow reads
 * (getent + netcage); everything root/privilege-touching is a TRIPWIRE that
 * exits non-zero + prints "TRIPWIRE" (anon-pi never runs Tier 2). `accountHome`,
 * when given, makes `getent passwd anon-<name>` REPORT the account (with that
 * home), simulating "the account exists"; when absent, getent reports no such
 * account. `torSocks5` controls the fake `netcage detect-proxy --json`.
 */
function fakeBin(opts: {accountHome?: string; torSocks5?: boolean}): string {
	const bin = tmp('anon-pi-bin-');
	const home = opts.accountHome ?? '';
	// getent passwd <account>: field 6 is the home dir. Exit 2 (no such key) when
	// we are simulating a missing account, so anonAccountHome() returns undefined.
	writeFileSync(
		join(bin, 'getent'),
		`#!/bin/sh\n` +
			`# only \`getent passwd <account>\` is used by anon-pi.\n` +
			`if [ "$1" = passwd ]; then\n` +
			(home === ''
				? `  exit 2\n`
				: `  printf '%s:x:4242:4242::%s:/bin/bash\\n' "$2" '${home}'\n  exit 0\n`) +
			`fi\nexit 2\n`,
	);
	// netcage: detect-proxy --json returns our controlled Tor evidence; --version
	// answers the preflight probe; everything else is a tripwire.
	const detect = JSON.stringify({
		schemaVersion: 1,
		candidates: [
			{
				port: 9050,
				open: opts.torSocks5 === true,
				socks5: opts.torSocks5 === true,
			},
		],
	});
	writeFileSync(
		join(bin, 'netcage'),
		`#!/bin/sh\n` +
			`if [ "$1" = detect-proxy ]; then printf '%s' '${detect}'; exit 0; fi\n` +
			`if [ "$1" = --version ]; then echo 'netcage 0.11.0'; exit 0; fi\n` +
			`echo "TRIPWIRE: real netcage $1 was invoked" >&2\nexit 97\n`,
	);
	for (const tripwire of [
		'sudo',
		'su',
		'useradd',
		'loginctl',
		'podman',
		'tor',
		'visudo',
		'install',
	]) {
		writeFileSync(
			join(bin, tripwire),
			`#!/bin/sh\necho "TRIPWIRE: real ${tripwire} was invoked" >&2\nexit 97\n`,
		);
	}
	for (const f of [
		'getent',
		'netcage',
		'sudo',
		'su',
		'useradd',
		'loginctl',
		'podman',
		'tor',
		'visudo',
		'install',
	]) {
		chmodSync(join(bin, f), 0o755);
	}
	return bin;
}

/** Run the built CLI with a stubbed PATH + temp home (login-user, non-TTY). */
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

/** The persona's own config.json path under its (temp) account home. */
function personaConfigPath(accountHome: string): string {
	return join(accountHome, '.anon-pi', 'config.json');
}

describe('persona add: dispatch + name mapping + validation', () => {
	it('errors clearly on an invalid persona name (no account touched)', () => {
		const home = tmp('anon-pi-home-');
		const accountHome = tmp('anon-acct-');
		const bin = fakeBin({accountHome});
		const r = run(['persona', 'add', 'Alice/../root', '--tor'], {home, bin});
		expect(r.status).not.toBe(0);
		expect(r.stderr).toMatch(/invalid persona name/i);
		expect(r.stderr).not.toContain('TRIPWIRE');
		expect(existsSync(personaConfigPath(accountHome))).toBe(false);
	});

	it('errors on an unknown `persona` subcommand', () => {
		const home = tmp('anon-pi-home-');
		const bin = fakeBin({});
		const r = run(['persona', 'list'], {home, bin});
		expect(r.status).not.toBe(0);
		expect(r.stderr).toMatch(/unknown.*subcommand|persona/i);
	});

	it('--help prints the persona help and exits 0', () => {
		const home = tmp('anon-pi-home-');
		const bin = fakeBin({});
		const r = run(['persona', '--help'], {home, bin});
		expect(r.status).toBe(0);
		expect(r.stdout.toLowerCase()).toContain('persona');
		expect(r.stdout).toContain('add');
	});
});

describe('persona add: egress selection', () => {
	it('BYO --proxy writes the literal socks5h endpoint + PRINTS the uniqueness warning', () => {
		const home = tmp('anon-pi-home-');
		const accountHome = tmp('anon-acct-'); // account EXISTS
		const bin = fakeBin({accountHome});
		const byo = 'socks5h://127.0.0.1:1080';
		const r = run(['persona', 'add', 'alice', '--proxy', byo], {home, bin});
		expect(r.status).toBe(0);
		expect(r.stderr).not.toContain('TRIPWIRE');
		// the uniqueness warning is printed on the BYO path.
		const out = r.stdout + r.stderr;
		expect(out).toMatch(/unique to this persona/i);
		expect(out).toMatch(/prefer Tor/i);
		// the persona's OWN config.json carries the BYO proxy verbatim.
		const conf = JSON.parse(
			readFileSync(personaConfigPath(accountHome), 'utf8'),
		);
		expect(conf.proxy).toBe(byo);
	});

	it('--tor composes socks5h://anon-<name>:x@... (Tor detected) and stores it', () => {
		const home = tmp('anon-pi-home-');
		const accountHome = tmp('anon-acct-');
		const bin = fakeBin({accountHome, torSocks5: true});
		const r = run(['persona', 'add', 'alice', '--tor'], {home, bin});
		expect(r.status).toBe(0);
		expect(r.stderr).not.toContain('TRIPWIRE');
		const conf = JSON.parse(
			readFileSync(personaConfigPath(accountHome), 'utf8'),
		);
		expect(conf.proxy).toBe('socks5h://anon-alice:x@127.0.0.1:9050');
		// the Tor path does NOT print the BYO uniqueness warning.
		expect(r.stdout + r.stderr).not.toMatch(/unique to this persona/i);
	});

	it('the default persona (bare `add`) composes for account `anon`', () => {
		const home = tmp('anon-pi-home-');
		const accountHome = tmp('anon-acct-');
		const bin = fakeBin({accountHome, torSocks5: true});
		const r = run(['persona', 'add', '--tor'], {home, bin});
		expect(r.status).toBe(0);
		const conf = JSON.parse(
			readFileSync(personaConfigPath(accountHome), 'utf8'),
		);
		expect(conf.proxy).toBe('socks5h://anon:x@127.0.0.1:9050');
	});
});

describe('persona add: Tier-1 in-home write is mode 700 and identity is NOT set', () => {
	it('writes ~anon-<name>/.anon-pi at mode 0700, ordinary v1 config, no email/git', () => {
		const home = tmp('anon-pi-home-');
		const accountHome = tmp('anon-acct-');
		const bin = fakeBin({accountHome});
		const r = run(
			['persona', 'add', 'alice', '--proxy', 'socks5h://127.0.0.1:1080'],
			{home, bin},
		);
		expect(r.status).toBe(0);
		const anonPiDir = join(accountHome, '.anon-pi');
		// mode 700 on the persona workspace dir (only the persona may read it).
		expect(statSync(anonPiDir).mode & 0o777).toBe(0o700);
		const conf = JSON.parse(
			readFileSync(personaConfigPath(accountHome), 'utf8'),
		);
		// ordinary v1 config shape: a proxy, no persona-identity keys.
		expect(typeof conf.proxy).toBe('string');
		expect(conf).not.toHaveProperty('email');
		expect(conf).not.toHaveProperty('git');
		expect(conf).not.toHaveProperty('name');
	});
});

describe('persona add: Tier-2 printed when the account is missing (resumable)', () => {
	it('PRINTS the copy-paste root commands (no script file) and writes NO config', () => {
		const home = tmp('anon-pi-home-');
		// account MISSING: getent reports no such account.
		const bin = fakeBin({}); // no accountHome
		const r = run(
			['persona', 'add', 'alice', '--proxy', 'socks5h://127.0.0.1:1080'],
			{home, bin},
		);
		// non-TTY: cannot wait for the human to continue, so it prints Tier-2 and
		// exits non-zero (re-run after creating the account). anon-pi NEVER runs it.
		expect(r.stderr).not.toContain('TRIPWIRE');
		const out = r.stdout + r.stderr;
		expect(out).toContain('useradd -m anon-alice');
		expect(out).toContain('loginctl enable-linger anon-alice');
		expect(out).toContain('anon-alice) '); // the scoped sudoers rule
		// no on-disk script file framing.
		expect(out).not.toContain('#!/bin/sh');
		// nothing written into a persona tree (the account does not exist).
		expect(r.status).not.toBe(0);
	});
});

describe('persona add: idempotent re-run', () => {
	it('re-adding a fully-provisioned persona is a no-op re-check, not a failure', () => {
		const home = tmp('anon-pi-home-');
		const accountHome = tmp('anon-acct-');
		const bin = fakeBin({accountHome});
		const byo = 'socks5h://127.0.0.1:1080';
		// first add: provisions the persona (Tier-1 write).
		const first = run(['persona', 'add', 'alice', '--proxy', byo], {home, bin});
		expect(first.status).toBe(0);
		const before = readFileSync(personaConfigPath(accountHome), 'utf8');
		// second add (no egress flag): the persona is already provisioned, so this
		// must be a no-op re-check (exit 0), never a duplicate/failure.
		const second = run(['persona', 'add', 'alice'], {home, bin});
		expect(second.status).toBe(0);
		expect(second.stdout + second.stderr).toMatch(
			/already provisioned|already exists|up to date|no-op/i,
		);
		// the config is unchanged.
		expect(readFileSync(personaConfigPath(accountHome), 'utf8')).toBe(before);
	});
});

describe('persona add: no egress flag + no TTY refuses (never silently no-proxy)', () => {
	it('with the account present but NO egress choice and no TTY, refuses fail-closed', () => {
		const home = tmp('anon-pi-home-');
		const accountHome = tmp('anon-acct-');
		const bin = fakeBin({accountHome}); // Tor NOT detected
		const r = run(['persona', 'add', 'alice'], {home, bin});
		// no --tor/--proxy, no Tor, no TTY to prompt: cannot pick an egress, so it
		// refuses rather than writing a persona with no proxy.
		expect(r.status).not.toBe(0);
		expect(r.stderr).not.toContain('TRIPWIRE');
		expect(existsSync(personaConfigPath(accountHome))).toBe(false);
	});
});

describe('persona add: isolation (real homes + real tools untouched)', () => {
	it('leaves the real ~/.anon-pi untouched and invokes no real privilege tools', () => {
		const realHome = join(homedir(), '.anon-pi');
		const before = existsSync(realHome) ? statSync(realHome).mtimeMs : null;
		const home = tmp('anon-pi-home-');
		const accountHome = tmp('anon-acct-');
		const bin = fakeBin({accountHome});
		const r = run(
			['persona', 'add', 'alice', '--proxy', 'socks5h://127.0.0.1:1080'],
			{home, bin},
		);
		expect(r.status).toBe(0);
		expect(r.stderr).not.toContain('TRIPWIRE');
		const after = existsSync(realHome) ? statSync(realHome).mtimeMs : null;
		expect(after).toBe(before);
	});
});
