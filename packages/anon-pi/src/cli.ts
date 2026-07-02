#!/usr/bin/env node
// anon-pi CLI. Two commands:
//   anon-pi [WORKDIR]   resolve the run plan (pure) and exec `netcage run ...`
//                       with inherited stdio (so -it is a real interactive TTY).
//                       The seed models.json is mounted read-only and copied
//                       into the container's ~/.pi/agent by the run command, so
//                       it layers onto the image's config (extensions survive).
//   anon-pi import      generate the seed models.json from the host models.json,
//                       carrying only the provider that serves ANON_PI_LLM.

import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {
	AnonPiError,
	buildRunPlan,
	envFromProcess,
	HELP,
	MODELS_FILE,
	pickProviderForLlm,
	resolveConfigSeed,
	resolveSourceModelsPath,
	type PiModelsFile,
} from './anon-pi.js';

function main(argv: string[]): number {
	const args = argv.slice(2);

	if (args.includes('--help') || args.includes('-h')) {
		process.stdout.write(HELP);
		return 0;
	}

	// Subcommand dispatch: the first bare token may be `import`.
	if (args[0] === 'import') {
		return runImport(args.slice(1));
	}

	return runLaunch(args);
}

// --- anon-pi [WORKDIR] : launch pi jailed -----------------------------------
function runLaunch(args: string[]): number {
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
		plan = buildRunPlan(env, positionals[0], existsSync);
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

// --- anon-pi import : write the seed models.json ----------------------------
function runImport(args: string[]): number {
	const force = args.includes('--force') || args.includes('-f');
	const stray = args.filter(
		(a) => a.startsWith('-') && a !== '--force' && a !== '-f',
	);
	if (stray.length > 0) {
		process.stderr.write(
			`anon-pi import: unknown option(s): ${stray.join(' ')}\nRun \`anon-pi --help\`.\n`,
		);
		return 2;
	}

	const env = envFromProcess(process.env);

	if (!env.llmDirect || env.llmDirect.trim() === '') {
		process.stderr.write(
			'anon-pi import: set ANON_PI_LLM to the RFC1918/link-local IP[:port] of the local\n' +
				'model whose provider should be imported (e.g. ANON_PI_LLM=192.168.1.150:8080).\n',
		);
		return 1;
	}

	const source = resolveSourceModelsPath(env);
	if (!existsSync(source)) {
		process.stderr.write(
			`anon-pi import: host models.json not found at ${source}.\n` +
				'Set ANON_PI_SOURCE_MODELS to your pi models.json, or run pi once to create it.\n',
		);
		return 1;
	}

	let hostModels: PiModelsFile;
	try {
		hostModels = JSON.parse(readFileSync(source, 'utf8')) as PiModelsFile;
	} catch (e) {
		process.stderr.write(
			`anon-pi import: could not parse ${source}: ${(e as Error).message}\n`,
		);
		return 1;
	}

	let result;
	try {
		result = pickProviderForLlm(hostModels, env.llmDirect);
	} catch (e) {
		if (e instanceof AnonPiError) {
			process.stderr.write(e.message + '\n');
			return 1;
		}
		throw e;
	}

	const seedDir = resolveConfigSeed(env);
	const dest = join(seedDir, MODELS_FILE);
	if (existsSync(dest) && !force) {
		process.stderr.write(
			`anon-pi import: ${dest} already exists. Re-run with --force to overwrite.\n`,
		);
		return 1;
	}

	if (result.apiKeyLooksReal) {
		process.stderr.write(
			`anon-pi import: WARNING: provider "${result.name}" carries a real-looking apiKey; it\n` +
				'will be written into the seed. For a local model this is usually fine, but review\n' +
				`${dest} if that key identifies you.\n`,
		);
	}

	mkdirSync(seedDir, {recursive: true});
	writeFileSync(dest, JSON.stringify(result.models, null, 2) + '\n');
	process.stderr.write(
		`anon-pi import: wrote ${dest} (provider "${result.name}"). Run \`anon-pi\` to launch.\n`,
	);
	return 0;
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
