// Grammar A parsing: the pure argv->ParsedLaunch seam the launch CLI is built
// on (bare positional = PROJECT; `-m` = machine; `--shell [p]`;
// `--mount <parent> [p]`; `--keep`/`--rm` default; `.` root token; trailing
// `<pi-args…>` after the project forwarded to pi). Enforces the reserved-name
// guard (via validateName) and NAME vs `--mount` exclusivity.
//
// PURE (no spawn/fs): argv in -> ParsedLaunch out (or an AnonPiError). The CLI
// combines the result with config/machine reads + the RunPlan resolver.
import {describe, it, expect} from 'vitest';
import {
	AnonPiError,
	DEFAULT_MACHINE,
	parseLaunchArgs,
	ROOT_TOKEN,
} from '../src/index.js';

describe('parseLaunchArgs — modes + the bare menu', () => {
	it('bare (no args) is the menu on the default machine', () => {
		const p = parseLaunchArgs([]);
		expect(p.mode).toBe('menu');
		expect(p.machine).toBe(DEFAULT_MACHINE);
		expect(p.project).toBeUndefined();
		expect(p.keep).toBe(false);
	});

	it('a bare positional is a PROJECT (pi mode) on the default machine', () => {
		const p = parseLaunchArgs(['recon']);
		expect(p.mode).toBe('pi');
		expect(p.machine).toBe(DEFAULT_MACHINE);
		expect(p.project).toBe('recon');
		expect(p.piArgs).toBeUndefined();
	});

	it('the `.` root token is a valid project token (not rejected as a name)', () => {
		const p = parseLaunchArgs(['.']);
		expect(p.mode).toBe('pi');
		expect(p.project).toBe(ROOT_TOKEN);
	});

	it('`-m <machine>` picks the machine (validated)', () => {
		const p = parseLaunchArgs(['-m', 'webveil', 'recon']);
		expect(p.machine).toBe('webveil');
		expect(p.project).toBe('recon');
	});

	it('`-m <machine>` with no project is the menu for that machine', () => {
		const p = parseLaunchArgs(['-m', 'webveil']);
		expect(p.mode).toBe('menu');
		expect(p.machine).toBe('webveil');
	});

	it('machineExplicit flags whether -m was given (so `-m default` wins over config)', () => {
		expect(parseLaunchArgs(['recon']).machineExplicit).toBe(false);
		expect(
			parseLaunchArgs(['-m', DEFAULT_MACHINE, 'recon']).machineExplicit,
		).toBe(true);
		expect(parseLaunchArgs(['-m', 'webveil']).machineExplicit).toBe(true);
	});
});

describe('parseLaunchArgs — --shell', () => {
	it('--shell with no project is a bash at the machine home', () => {
		const p = parseLaunchArgs(['--shell']);
		expect(p.mode).toBe('shell');
		expect(p.project).toBeUndefined();
	});

	it('--shell <project> is a bash cwd into the project', () => {
		const p = parseLaunchArgs(['--shell', 'recon']);
		expect(p.mode).toBe('shell');
		expect(p.project).toBe('recon');
	});

	it('--shell . is a bash at the root token', () => {
		expect(parseLaunchArgs(['--shell', '.']).project).toBe('.');
	});
});

describe('parseLaunchArgs — --mount', () => {
	it('--mount <parent> with no project re-roots at the host parent (menu)', () => {
		const p = parseLaunchArgs(['--mount', '/host/dev']);
		expect(p.mountParent).toBe('/host/dev');
		expect(p.mode).toBe('menu');
		expect(p.project).toBeUndefined();
	});

	it('--mount <parent> <project> pi into /work/<project>, parent mounted', () => {
		const p = parseLaunchArgs(['--mount', '/host/dev', 'sub']);
		expect(p.mountParent).toBe('/host/dev');
		expect(p.mode).toBe('pi');
		expect(p.project).toBe('sub');
	});

	it('--mount <parent> . is the root token under the mount parent', () => {
		const p = parseLaunchArgs(['--mount', '/host/dev', '.']);
		expect(p.mountParent).toBe('/host/dev');
		expect(p.project).toBe('.');
	});

	it('--shell composes with --mount', () => {
		const p = parseLaunchArgs(['--mount', '/host/dev', '--shell', 'sub']);
		expect(p.mode).toBe('shell');
		expect(p.mountParent).toBe('/host/dev');
		expect(p.project).toBe('sub');
	});

	it('errors when --mount has no parent argument', () => {
		expect(() => parseLaunchArgs(['--mount'])).toThrow(AnonPiError);
	});
});

describe('parseLaunchArgs — --keep / --rm (throwaway default)', () => {
	it('defaults to --rm (keep=false)', () => {
		expect(parseLaunchArgs(['recon']).keep).toBe(false);
		expect(parseLaunchArgs(['--rm', 'recon']).keep).toBe(false);
	});

	it('--keep leaves the container kept (keep=true)', () => {
		expect(parseLaunchArgs(['--keep', 'recon']).keep).toBe(true);
	});

	it('errors when --keep and --rm are BOTH given (contradictory)', () => {
		expect(() => parseLaunchArgs(['--keep', '--rm', 'recon'])).toThrow(
			AnonPiError,
		);
	});
});

describe('parseLaunchArgs — forwarded pi args', () => {
	it('trailing args after the project are forwarded to pi verbatim', () => {
		const p = parseLaunchArgs(['recon', '-p', 'do a thing']);
		expect(p.mode).toBe('pi');
		expect(p.project).toBe('recon');
		expect(p.piArgs).toEqual(['-p', 'do a thing']);
	});

	it('anon-pi flags BEFORE the project still parse; everything after is pi args', () => {
		const p = parseLaunchArgs([
			'-m',
			'webveil',
			'--keep',
			'recon',
			'--flag',
			'x',
		]);
		expect(p.machine).toBe('webveil');
		expect(p.keep).toBe(true);
		expect(p.project).toBe('recon');
		expect(p.piArgs).toEqual(['--flag', 'x']);
	});

	it('--shell ignores forwarded args (bash has no forwarded-args grammar)', () => {
		// after --shell <project>, trailing tokens are not a pi-args forward.
		expect(() => parseLaunchArgs(['--shell', 'recon', 'extra'])).toThrow(
			AnonPiError,
		);
	});
});

describe('parseLaunchArgs — reserved-name guard + validation', () => {
	it('rejects an invalid project name (path separator)', () => {
		expect(() => parseLaunchArgs(['a/b'])).toThrow(AnonPiError);
	});

	it('rejects a traversal project name (..)', () => {
		expect(() => parseLaunchArgs(['..'])).toThrow(AnonPiError);
	});

	it('rejects an invalid machine name via -m', () => {
		expect(() => parseLaunchArgs(['-m', 'a/b', 'recon'])).toThrow(AnonPiError);
	});

	it('errors on an unknown option', () => {
		expect(() => parseLaunchArgs(['--nope'])).toThrow(AnonPiError);
	});

	it('errors when -m has no machine argument', () => {
		expect(() => parseLaunchArgs(['-m'])).toThrow(AnonPiError);
	});
});
