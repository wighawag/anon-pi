import {describe, it, expect, beforeAll} from 'vitest';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	writeFileSync,
} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

// Exercises the cli.ts-level --fresh / --ephemeral behaviour (not in the pure
// module) by spawning the built CLI with a fake `netcage` on PATH, so nothing
// real is launched. Requires the package to be built (dist/cli.js); CI builds
// before test.

const cli = join(
	dirname(fileURLToPath(import.meta.url)),
	'..',
	'dist',
	'cli.js',
);

let workRoot: string;
let fakeBin: string;

function run(args: string[], home: string) {
	return spawnSync(process.execPath, [cli, ...args], {
		encoding: 'utf8',
		env: {
			...process.env,
			PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
			ANON_PI_IMAGE: 'my/pi:tag',
			ANON_PI_LLM: '192.168.1.150:8080',
			ANON_PI_PROXY: 'socks5h://127.0.0.1:1080',
			ANON_PI_HOME: home,
		},
	});
}

beforeAll(() => {
	// a fake `netcage` that just succeeds, so no real jail is launched
	fakeBin = mkdtempSync(join(tmpdir(), 'anon-pi-fakebin-'));
	const nc = join(fakeBin, 'netcage');
	writeFileSync(nc, '#!/bin/sh\nexit 0\n', {mode: 0o755});
	workRoot = mkdtempSync(join(tmpdir(), 'anon-pi-fresh-'));
});

describe('anon-pi --fresh', () => {
	it('deletes the workdir state home then re-seeds it (fresh)', () => {
		const home = mkdtempSync(join(tmpdir(), 'anon-pi-home-'));
		mkdirSync(join(home, 'agent'), {recursive: true});
		writeFileSync(join(home, 'agent', 'models.json'), '{"providers":{}}');
		const work = join(workRoot, 'proj-a');

		// first launch creates the state home
		const first = run([work], home);
		expect(first.status).toBe(0);
		expect(first.stderr).toContain('new session home');

		// simulate a seeded home: find the slug dir and drop a marker + junk
		const stateRoot = join(home, 'state');
		const slug = readdirSync(stateRoot)[0];
		const agent = join(stateRoot, slug, 'agent');
		writeFileSync(join(agent, '.anon-pi-seed'), '1\n');
		writeFileSync(join(agent, 'sessions-junk'), 'stale');
		expect(existsSync(join(agent, '.anon-pi-seed'))).toBe(true);

		// --fresh must remove it and report the home as fresh again
		const fresh = run(['--fresh', work], home);
		expect(fresh.status).toBe(0);
		expect(fresh.stderr).toContain('--fresh removed');
		expect(fresh.stderr).toContain('new session home');
		// the stale marker/junk are gone (a fresh, re-seedable home)
		expect(existsSync(join(agent, '.anon-pi-seed'))).toBe(false);
		expect(existsSync(join(agent, 'sessions-junk'))).toBe(false);
	});

	it('rejects --fresh together with --ephemeral', () => {
		const home = mkdtempSync(join(tmpdir(), 'anon-pi-home-'));
		mkdirSync(join(home, 'agent'), {recursive: true});
		writeFileSync(join(home, 'agent', 'models.json'), '{"providers":{}}');
		const r = run(['--fresh', '--ephemeral', join(workRoot, 'proj-b')], home);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain('--fresh has no effect with --ephemeral');
	});

	it('is not a stray-flag error (accepts --fresh)', () => {
		const home = mkdtempSync(join(tmpdir(), 'anon-pi-home-'));
		mkdirSync(join(home, 'agent'), {recursive: true});
		writeFileSync(join(home, 'agent', 'models.json'), '{"providers":{}}');
		const r = run(['--fresh', join(workRoot, 'proj-c')], home);
		expect(r.stderr).not.toContain('unknown option');
		expect(r.status).toBe(0);
	});
});
