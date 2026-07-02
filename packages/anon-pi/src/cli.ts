#!/usr/bin/env node
// anon-pi CLI: resolve the run plan (pure), do the one filesystem side-effect
// (seed the session config if absent), then exec `netcage run ...` with inherited
// stdio so the interactive pi session (-it) passes through the terminal cleanly.

import {cpSync, existsSync, mkdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {dirname} from 'node:path';
import {AnonPiError, buildRunPlan, envFromProcess, HELP} from './anon-pi.js';

function main(argv: string[]): number {
	const args = argv.slice(2);

	if (args.includes('--help') || args.includes('-h')) {
		process.stdout.write(HELP);
		return 0;
	}

	// The only positional is the optional workdir. Reject stray flags so a typo
	// (e.g. --allow-direct) is not silently swallowed: anon-pi owns the netcage
	// argv, extra flags are not passed through.
	const positionals = args.filter((a) => !a.startsWith('-'));
	const flags = args.filter((a) => a.startsWith('-'));
	if (flags.length > 0) {
		process.stderr.write(
			`anon-pi: unknown option(s): ${flags.join(' ')}\nRun \`anon-pi --help\`.\n`,
		);
		return 2;
	}
	if (positionals.length > 1) {
		process.stderr.write(
			'anon-pi: too many arguments (expected at most one WORKDIR).\nRun `anon-pi --help`.\n',
		);
		return 2;
	}

	const env = envFromProcess(process.env);

	let plan;
	try {
		plan = buildRunPlan(env, positionals[0], existsSync, existsSync);
	} catch (e) {
		if (e instanceof AnonPiError) {
			process.stderr.write(e.message + '\n');
			return 1;
		}
		throw e;
	}

	// Fail loud if netcage is not installed, before we mutate anything.
	if (!hasNetcage()) {
		process.stderr.write(
			'anon-pi: `netcage` not found on PATH. anon-pi is a launcher for netcage; install it first\n' +
				'(https://github.com/wighawag/netcage). Linux only.\n',
		);
		return 1;
	}

	// The one side-effect: seed the per-session config from the canonical seed the
	// FIRST time this workdir is used. Reuse-if-present, seed-if-absent.
	if (plan.needsSeed) {
		mkdirSync(dirname(plan.sessionAgentDir), {recursive: true});
		cpSync(plan.configSeed, plan.sessionAgentDir, {recursive: true});
		process.stderr.write(
			`anon-pi: seeded session config -> ${plan.sessionAgentDir}\n`,
		);
	}

	// Ensure the workdir exists (a fresh named folder is fine).
	mkdirSync(plan.workdir, {recursive: true});

	// Hand off to netcage with inherited stdio so -it is a real interactive TTY.
	const res = spawnSync('netcage', plan.netcageArgs, {stdio: 'inherit'});
	if (res.error) {
		process.stderr.write(
			`anon-pi: failed to run netcage: ${res.error.message}\n`,
		);
		return 1;
	}
	// Propagate netcage's exit code (which itself propagates the tool's).
	return res.status ?? 1;
}

function hasNetcage(): boolean {
	const which = spawnSync(
		process.platform === 'win32' ? 'where' : 'command',
		['-v', 'netcage'],
		{
			stdio: 'ignore',
			shell: process.platform !== 'win32',
		},
	);
	if (which.status === 0) return true;
	// Fallback: try running it harmlessly.
	const probe = spawnSync('netcage', ['--help'], {stdio: 'ignore'});
	return !probe.error;
}

process.exit(main(process.argv));
