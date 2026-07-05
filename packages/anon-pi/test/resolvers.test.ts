// Machine + project resolvers, name validation, and the "." root token.
// Pure, isolated against a temp anon-pi home (injected via AnonPiEnv.anonPiHome):
// no real ~/.anon-pi is read or written.
import {describe, it, expect} from 'vitest';
import {resolve as pathResolve} from 'node:path';
import {
	AnonPiError,
	CONTAINER_MACHINE_HOME,
	CONTAINER_MOUNT_ROOT,
	CONTAINER_PROJECTS_ROOT,
	isRootToken,
	machineDir,
	machineHomeDir,
	machineJsonPath,
	projectContainerCwd,
	projectHostDir,
	resolveCwd,
	ROOT_TOKEN,
	rootCwd,
	validateName,
	type AnonPiEnv,
} from '../src/index.js';

// A temp anon-pi home, injected: nothing touches the real ~/.anon-pi.
const env: AnonPiEnv = {
	home: '/home/u',
	anonPiHome: '/tmp/anon-pi-home',
};

describe('machine resolvers (dir / machine.json / home)', () => {
	it('machineDir is <home>/machines/<name>', () => {
		expect(machineDir(env, 'recon')).toBe('/tmp/anon-pi-home/machines/recon');
	});

	it('machineJsonPath is the machine.json (image) under the machine dir', () => {
		expect(machineJsonPath(env, 'recon')).toBe(
			'/tmp/anon-pi-home/machines/recon/machine.json',
		);
	});

	it('machineHomeDir is the ONE mount at /root: <machineDir>/home', () => {
		expect(machineHomeDir(env, 'recon')).toBe(
			'/tmp/anon-pi-home/machines/recon/home',
		);
	});
});

describe('validateName (machines + projects)', () => {
	it('accepts ordinary folder-safe names and returns them', () => {
		for (const name of ['recon', 'my-project', 'proj_2', 'a.b.c', 'x1']) {
			expect(validateName(name, 'project')).toBe(name);
			expect(validateName(name, 'machine')).toBe(name);
		}
	});

	it('rejects a path separator / \\ or a colon', () => {
		for (const bad of ['a/b', 'a\\b', 'a:b', '/abs', 'c:\\x']) {
			expect(() => validateName(bad, 'project')).toThrow(AnonPiError);
		}
	});

	it('rejects the traversal token .. (and any leading dot)', () => {
		for (const bad of ['..', '.', '.hidden', '..', '...']) {
			expect(() => validateName(bad, 'project')).toThrow(AnonPiError);
		}
	});

	it('rejects whitespace (space, tab, newline) anywhere', () => {
		for (const bad of ['a b', ' a', 'a ', 'a\tb', 'a\nb']) {
			expect(() => validateName(bad, 'machine')).toThrow(AnonPiError);
		}
	});

	it('rejects an empty name', () => {
		expect(() => validateName('', 'project')).toThrow(AnonPiError);
	});

	it('rejects the reserved root token "." as a plain name', () => {
		// "." is the root token, never a machine/project name.
		expect(() => validateName('.', 'project')).toThrow(AnonPiError);
		expect(() => validateName('.', 'machine')).toThrow(AnonPiError);
	});

	it('rejects the reserved `pi` passthrough token as a plain name', () => {
		// `pi` is the `anon-pi pi <args…>` passthrough token, never a project.
		expect(() => validateName('pi', 'project')).toThrow(AnonPiError);
		expect(() => validateName('pi', 'machine')).toThrow(AnonPiError);
	});

	it('rejects the subcommand NOUN words (machine/image/init/forward/ports)', () => {
		// Each is dispatched before the launch grammar; a same-named folder would be
		// UNREACHABLE by bare name, so validateName refuses it up front (closing the
		// trap) with a clear "reserved name" error.
		for (const word of ['machine', 'image', 'init', 'forward', 'ports']) {
			let msg = '';
			try {
				validateName(word, 'project');
			} catch (e) {
				msg = (e as Error).message;
			}
			expect(msg.toLowerCase()).toContain('reserved name');
			expect(() => validateName(word, 'machine')).toThrow(AnonPiError);
		}
	});

	it('names the kind in the error (machine vs project)', () => {
		let msg = '';
		try {
			validateName('a/b', 'machine');
		} catch (e) {
			msg = (e as Error).message;
		}
		expect(msg.toLowerCase()).toContain('machine');
	});
});

describe('project resolvers (host subfolder + jail cwd)', () => {
	it('projectHostDir maps a name to the projects-root subfolder on the host', () => {
		expect(projectHostDir('/tmp/anon-pi-home/projects', 'recon')).toBe(
			'/tmp/anon-pi-home/projects/recon',
		);
	});

	it('projectHostDir works off a --mount parent root too', () => {
		expect(projectHostDir('/host/dev', 'recon')).toBe('/host/dev/recon');
	});

	it('projectHostDir validates the name (rejecting traversal)', () => {
		expect(() => projectHostDir('/tmp/projects', '../escape')).toThrow(
			AnonPiError,
		);
	});

	it('projectContainerCwd is the jail cwd /projects/<name> (pi conversation key)', () => {
		expect(projectContainerCwd('recon')).toBe('/projects/recon');
	});

	it('projectContainerCwd validates the name', () => {
		expect(() => projectContainerCwd('a/b')).toThrow(AnonPiError);
	});
});

describe('the "." root token', () => {
	it('ROOT_TOKEN is "." and isRootToken recognises exactly it', () => {
		expect(ROOT_TOKEN).toBe('.');
		expect(isRootToken('.')).toBe(true);
		expect(isRootToken('recon')).toBe(false);
		expect(isRootToken('..')).toBe(false);
		expect(isRootToken('')).toBe(false);
		expect(isRootToken(undefined)).toBe(false);
	});

	it('rootCwd is /projects, /work (mount), and ~ (machine)', () => {
		expect(rootCwd('projects')).toBe(CONTAINER_PROJECTS_ROOT);
		expect(rootCwd('mount')).toBe(CONTAINER_MOUNT_ROOT);
		expect(rootCwd('machine')).toBe(CONTAINER_MACHINE_HOME);
		expect(rootCwd('projects')).toBe('/projects');
		expect(rootCwd('mount')).toBe('/work');
		expect(rootCwd('machine')).toBe('~');
	});
});

describe('resolveCwd (uniform . vs named across every root)', () => {
	it('resolves "." to the root cwd of each context', () => {
		expect(resolveCwd('projects', '.')).toBe('/projects');
		expect(resolveCwd('mount', '.')).toBe('/work');
		expect(resolveCwd('machine', '.')).toBe('~');
	});

	it('resolves a named project to <root>/<name> under /projects and /work', () => {
		expect(resolveCwd('projects', 'recon')).toBe('/projects/recon');
		expect(resolveCwd('mount', 'recon')).toBe('/work/recon');
	});

	it('validates a named project (rejects traversal / separators)', () => {
		expect(() => resolveCwd('projects', '../x')).toThrow(AnonPiError);
		expect(() => resolveCwd('mount', 'a/b')).toThrow(AnonPiError);
	});

	it('a machine root takes only the root token, not a named subfolder', () => {
		// projects live at /projects or /work, never as a subfolder of the machine
		// home ~; only "." (the machine home itself) is valid for a machine root.
		expect(() => resolveCwd('machine', 'recon')).toThrow(AnonPiError);
	});
});
