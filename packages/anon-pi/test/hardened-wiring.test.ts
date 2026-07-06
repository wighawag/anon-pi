// End-to-end IMPURE wiring for the hardened deployment (docs/adr/0006, prd
// `hardened-dedicated-account-deployment` stories 3+4): the self-re-exec hook on
// the launch entry. On a hardened install a login-user invocation must re-exec
// via `sudo -u anon -i <anon-pi> "$@"`; a caller already running as `anon` must
// NOT (the loop guard, else an infinite re-exec).
//
// ISOLATION (the task's hard constraint): every OS-touching bit is stubbed. We
// point ANON_PI_HOME at a TEMP dir and PATH at a temp bin holding a FAKE `sudo`
// that just RECORDS its argv (never a real privilege crossing). Tripwire fakes
// for `podman`/`netcage`/`loginctl`/`su` fail LOUDLY if the redirect ever shells
// out to them. We assert the real `~/.anon-pi` mtime is unchanged. No real
// sudo/su/podman/netcage/loginctl ever runs.
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
 * WITHOUT running anything real. The other tools are TRIPWIRES: if the redirect
 * ever invokes them the test fails (the crossing must be a plain sudo spawn).
 */
function fakeBin(sudoLog: string): string {
	const bin = tmp('anon-pi-bin-');
	writeFileSync(
		join(bin, 'sudo'),
		`#!/bin/sh\nprintf '%s\\n' "$@" >>'${sudoLog}'\nexit 0\n`,
	);
	for (const tripwire of ['su', 'podman', 'netcage', 'loginctl']) {
		writeFileSync(
			join(bin, tripwire),
			`#!/bin/sh\necho "TRIPWIRE: real ${tripwire} was invoked" >&2\nexit 97\n`,
		);
	}
	for (const f of ['sudo', 'su', 'podman', 'netcage', 'loginctl']) {
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
function run(
	args: string[],
	opts: {home: string; bin: string; asAnon?: boolean},
) {
	return spawnSync(process.execPath, [cli, ...args], {
		encoding: 'utf8',
		env: {
			...process.env,
			PATH: `${opts.bin}:${process.env.PATH ?? ''}`,
			ANON_PI_HOME: opts.home,
			// The CLI's "am I anon?" probe reads os.userInfo().username; we cannot
			// change the real uid in a test, so the anon-caller case is covered at
			// the pure seam (shouldRedirectToAnon: hardened+anon => false). Here we
			// exercise the login-user path (username != 'anon').
			...(opts.asAnon ? {} : {}),
		},
	});
}

describe('hardened self-re-exec: a login-user launch redirects via sudo -u anon -i', () => {
	it('spawns `sudo -u anon -i <anon-pi> <args>` on a hardened install', () => {
		const home = tmp('anon-pi-home-');
		writeHardenedConfig(home, true);
		const sudoLog = join(tmp('anon-pi-log-'), 'sudo.log');
		const bin = fakeBin(sudoLog);

		const r = run(['recon', '--mount', '/tmp/x'], {home, bin});
		// the fake sudo exits 0, so the CLI returns 0 and does nothing else.
		expect(r.status).toBe(0);
		expect(existsSync(sudoLog)).toBe(true);
		const argv = readFileSync(sudoLog, 'utf8').trim().split('\n');
		// sudo saw: -u anon -i <anon-pi> recon --mount /tmp/x
		expect(argv.slice(0, 3)).toEqual(['-u', 'anon', '-i']);
		// the 4th arg is the anon-pi binary path; then the forwarded args verbatim.
		expect(argv.slice(4)).toEqual(['recon', '--mount', '/tmp/x']);
	});

	it('does NOT redirect (no sudo) on a NON-hardened install', () => {
		const home = tmp('anon-pi-home-');
		writeHardenedConfig(home, false);
		const sudoLog = join(tmp('anon-pi-log-'), 'sudo.log');
		const bin = fakeBin(sudoLog);

		// A non-hardened launch proceeds normally; with no real proxy it fails
		// closed (that is the launch's own error, not a redirect). The point is:
		// sudo was NEVER invoked.
		run(['recon'], {home, bin});
		expect(existsSync(sudoLog)).toBe(false);
	});

	it('does NOT redirect for `--version` (kept local, no sudo prompt)', () => {
		const home = tmp('anon-pi-home-');
		writeHardenedConfig(home, true);
		const sudoLog = join(tmp('anon-pi-log-'), 'sudo.log');
		const bin = fakeBin(sudoLog);

		const r = run(['--version'], {home, bin});
		expect(r.status).toBe(0);
		expect(r.stdout).toContain('anon-pi');
		// version is a trivial local string; it must not trigger the sudo crossing.
		expect(existsSync(sudoLog)).toBe(false);
	});

	it('redirects a SUBCOMMAND invocation too (before it touches the workspace)', () => {
		const home = tmp('anon-pi-home-');
		writeHardenedConfig(home, true);
		const sudoLog = join(tmp('anon-pi-log-'), 'sudo.log');
		const bin = fakeBin(sudoLog);

		const r = run(['machine', 'list'], {home, bin});
		expect(r.status).toBe(0);
		const argv = readFileSync(sudoLog, 'utf8').trim().split('\n');
		expect(argv.slice(0, 3)).toEqual(['-u', 'anon', '-i']);
		expect(argv.slice(4)).toEqual(['machine', 'list']);
	});
});

describe('isolation: the hardened redirect never touches real homes or real tools', () => {
	it('leaves the real ~/.anon-pi untouched and invokes only the fake sudo', () => {
		const realHome = join(homedir(), '.anon-pi');
		const before = existsSync(realHome) ? statSync(realHome).mtimeMs : null;

		const home = tmp('anon-pi-home-');
		writeHardenedConfig(home, true);
		const sudoLog = join(tmp('anon-pi-log-'), 'sudo.log');
		const bin = fakeBin(sudoLog);

		const r = run(['recon'], {home, bin});
		// tripwires (su/podman/netcage/loginctl) exit 97 if hit; a clean redirect
		// only calls the fake sudo (exit 0).
		expect(r.status).toBe(0);
		expect(r.stderr).not.toContain('TRIPWIRE');

		const after = existsSync(realHome) ? statSync(realHome).mtimeMs : null;
		expect(after).toBe(before);
	});
});
