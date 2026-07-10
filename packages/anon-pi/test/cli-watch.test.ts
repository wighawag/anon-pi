// End-to-end for the `-p --mode text-stream` WATCH path: a FAKE `netcage` on
// PATH emits a canned pi `--mode json` JSONL stream on STDOUT (that is what pi
// prints inside the jail with the injected `--mode json`), and we assert the
// thin I/O the CLI adds: the composed argv forwards `--mode json` (NOT
// `text-stream`), the rendered per-turn view (assistant text + `▶ <tool>`) lands
// on STDERR, and pi's FINAL ANSWER lands on STDOUT (so the run stays pipeable).
// The pure classifier/rewrite are covered at the seam (watch-stream.test.ts);
// this covers only the pipe wiring.
//
// Requires the package to be built (dist/cli.js); CI builds before test.
import {describe, it, expect, beforeAll} from 'vitest';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const cli = join(
	dirname(fileURLToPath(import.meta.url)),
	'..',
	'dist',
	'cli.js',
);

let fakeBin: string;

// The canned pi `--mode json` stream the fake netcage replays: a lifecycle
// preamble, an assistant turn with text + a tool call, a tool result, then a
// final answer turn. Only the two `message_end` assistant records are
// high-signal; everything else must be skipped by the renderer.
const CANNED_STREAM = [
	JSON.stringify({type: 'session', id: 's1', cwd: '/projects/recon'}),
	JSON.stringify({type: 'agent_start'}),
	JSON.stringify({type: 'turn_start'}),
	JSON.stringify({
		type: 'message_update',
		assistantMessageEvent: {type: 'text_delta', delta: "I'll list"},
	}),
	JSON.stringify({
		type: 'message_end',
		message: {
			role: 'assistant',
			content: [
				{type: 'text', text: "I'll list the files."},
				{type: 'toolCall', id: 't1', name: 'ls', arguments: {path: '.'}},
			],
		},
	}),
	JSON.stringify({
		type: 'message_end',
		message: {role: 'toolResult', content: [{type: 'text', text: 'a\nb'}]},
	}),
	JSON.stringify({
		type: 'message_end',
		message: {role: 'assistant', content: [{type: 'text', text: 'Done.'}]},
	}),
	JSON.stringify({type: 'agent_end', messages: [], willRetry: false}),
].join('\n');

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
			ANON_PI_ARGV_LOG: join(fakeBin, 'argv.log'),
			// force NO colour so the assertions match plain text.
			NO_COLOR: '1',
		},
	});
}

beforeAll(() => {
	fakeBin = mkdtempSync(join(tmpdir(), 'anon-pi-watchbin-'));
	// The fake netcage: `--help`/`ps` succeed (install probe + kept query);
	// `--version` reports >= NETCAGE_MIN_VERSION so the launch-time gate passes
	// (the WATCH path is jail-entering, so it probes the version too); a `run`
	// prints the canned JSONL stream to STDOUT (as pi would inside the jail) and
	// records its argv.
	const nc = join(fakeBin, 'netcage');
	writeFileSync(
		nc,
		[
			'#!/usr/bin/env node',
			'const fs = require("fs");',
			'const argv = process.argv.slice(2);',
			'if (argv[0] === "--version") { process.stdout.write("netcage 0.12.0\\n"); process.exit(0); }',
			'if (argv[0] === "--help") process.exit(0);',
			'if (argv[0] === "ps") process.exit(0);',
			'if (process.env.ANON_PI_ARGV_LOG) {',
			'  fs.appendFileSync(process.env.ANON_PI_ARGV_LOG, JSON.stringify(argv) + "\\n");',
			'}',
			`process.stdout.write(${JSON.stringify(CANNED_STREAM + '\n')});`,
			'process.exit(0);',
		].join('\n'),
		{mode: 0o755},
	);
});

describe('anon-pi <project> -p --mode text-stream (WATCH)', () => {
	it('forwards `--mode json` to pi (never `text-stream`) and exits 0', () => {
		const home = mkdtempSync(join(tmpdir(), 'anon-pi-whome-'));
		const r = run(['recon', '-p', '--mode', 'text-stream', 'go'], home);
		expect(r.status).toBe(0);
		const joined = r.stderr; // argv is also logged, but check the forwarded tail via the pi args
		expect(joined).not.toContain('text-stream');
		// pi is invoked with the injected --mode json (seed wrapper forwards $@).
		// The whole netcage command line ends with the pi args; assert via stderr
		// render + the fact that the run succeeded is enough for the pipe; the argv
		// is asserted below through the log.
		const argvLine = require('node:fs')
			.readFileSync(join(fakeBin, 'argv.log'), 'utf8')
			.trim()
			.split('\n')
			.pop();
		const argv = JSON.parse(argvLine) as string[];
		expect(argv).toContain('--mode');
		expect(argv[argv.indexOf('--mode') + 1]).toBe('json');
		expect(argv).not.toContain('text-stream');
		// the headless shape: NO -it (a watch run is headless).
		expect(argv).not.toContain('-it');
	});

	it('renders the per-turn view (text + `▶ <tool>`) to STDERR', () => {
		const home = mkdtempSync(join(tmpdir(), 'anon-pi-whome-'));
		const r = run(['recon', '-p', '--mode', 'text-stream', 'go'], home);
		expect(r.stderr).toContain("I'll list the files.");
		expect(r.stderr).toContain('▶ ls');
		// the tool-result turn (role toolResult) is NOT surfaced.
		expect(r.stderr).not.toContain('a\nb');
	});

	it('prints pi\u2019s FINAL ANSWER to STDOUT (pipeable), not the intermediate text', () => {
		const home = mkdtempSync(join(tmpdir(), 'anon-pi-whome-'));
		const r = run(['recon', '-p', '--mode', 'text-stream', 'go'], home);
		// stdout carries ONLY the last answer, so `... | cat` yields the answer.
		expect(r.stdout.trim()).toBe('Done.');
		// stdout must NOT carry the raw JSON stream.
		expect(r.stdout).not.toContain('message_end');
	});

	it('REFUSES `--mode text-stream` without `-p` (interactive) with exit 1', () => {
		const home = mkdtempSync(join(tmpdir(), 'anon-pi-whome-'));
		const r = run(['recon', '--mode', 'text-stream'], home);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain('-p');
	});
});
