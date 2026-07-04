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
	isHeadlessPiArgs,
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

describe('parseLaunchArgs — pi session resume (no project)', () => {
	// The RESUME family (`--session`/`--session-id`/`--resume`/`-r <id>`) forwards
	// to pi with NO anon-pi project: the CLI resolves the session's cwd from the
	// store and cds there so pi resumes in place. So pi's own hint `pi --session
	// <id>` is usable as `anon-pi --session <id>`.
	for (const flags of [
		['--session', '019f2bde-fd47'],
		['--session-id', 'abc'],
		['--resume'],
		['-r'],
		['--resume', 'abc123'],
	]) {
		it(`\`${flags.join(' ')}\` is a no-project pi launch that forwards to pi`, () => {
			const p = parseLaunchArgs(flags);
			expect(p.mode).toBe('pi');
			expect(p.project).toBeUndefined();
			expect(p.piArgs).toEqual(flags);
		});
	}

	// --fork / --continue REFUSE the no-project position: they would land a new /
	// newest conversation in the projects root by surprise. The user must name a
	// project (`.` for the root; created on demand).
	for (const flags of [
		['--fork', 'abc123'],
		['--fork'],
		['--continue'],
		['-c'],
	]) {
		it(`\`${flags.join(' ')}\` with no project is refused (needs a project)`, () => {
			expect(() => parseLaunchArgs(flags)).toThrow(AnonPiError);
			expect(() => parseLaunchArgs(flags)).toThrow(/needs a project/);
		});
	}

	it('the --fork refusal names a copy-pasteable project example with the id', () => {
		expect(() => parseLaunchArgs(['--fork', 'sess-1'])).toThrow(
			/anon-pi <project> --fork sess-1/,
		);
		expect(() => parseLaunchArgs(['--fork', 'sess-1'])).toThrow(
			/anon-pi \. --fork sess-1/,
		);
	});

	it('-c is quoted as --continue in its no-project refusal', () => {
		expect(() => parseLaunchArgs(['-c'])).toThrow(/--continue needs a project/);
	});

	// --fork / --continue DO work once a project (or `.`) is given: the project is
	// created on demand, so the fork lands in a known directory.
	it('--fork AFTER a project is forwarded (fork into that project)', () => {
		const p = parseLaunchArgs(['newproj', '--fork', 'sess-1']);
		expect(p.mode).toBe('pi');
		expect(p.project).toBe('newproj');
		expect(p.piArgs).toEqual(['--fork', 'sess-1']);
	});

	it('--continue AFTER the `.` root is forwarded (continue at the root)', () => {
		const p = parseLaunchArgs(['.', '--continue']);
		expect(p.mode).toBe('pi');
		expect(p.project).toBe('.');
		expect(p.piArgs).toEqual(['--continue']);
	});

	it('honours -m before a session flag (picks the machine)', () => {
		const p = parseLaunchArgs(['-m', 'webveil', '--session', 'xyz']);
		expect(p.machine).toBe('webveil');
		expect(p.machineExplicit).toBe(true);
		expect(p.mode).toBe('pi');
		expect(p.project).toBeUndefined();
		expect(p.piArgs).toEqual(['--session', 'xyz']);
	});

	it('forwards everything AFTER the session flag verbatim', () => {
		const p = parseLaunchArgs(['--session', 'xyz', '--model', 'foo']);
		expect(p.piArgs).toEqual(['--session', 'xyz', '--model', 'foo']);
	});

	it('a session flag AFTER a project is just forwarded (existing behaviour)', () => {
		const p = parseLaunchArgs(['recon', '--session', 'xyz']);
		expect(p.project).toBe('recon');
		expect(p.piArgs).toEqual(['--session', 'xyz']);
	});

	it('--shell + a session flag is an error (a shell has no session)', () => {
		expect(() => parseLaunchArgs(['--shell', '--session', 'x'])).toThrow(
			AnonPiError,
		);
	});

	it('--keep --rm with a session flag is still contradictory', () => {
		expect(() => parseLaunchArgs(['--keep', '--rm', '--session', 'x'])).toThrow(
			AnonPiError,
		);
	});

	it('--list-models / --models are no-project pi query launches', () => {
		for (const flag of ['--list-models', '--models']) {
			const p = parseLaunchArgs([flag]);
			expect(p.mode).toBe('pi');
			expect(p.project).toBeUndefined();
			expect(p.piArgs).toEqual([flag]);
		}
	});
});

describe('parseLaunchArgs — the `pi` passthrough (any pi flags, no project)', () => {
	it('`pi <args…>` forwards everything to pi with no project', () => {
		const p = parseLaunchArgs(['pi', '--model', 'qwen', '--thinking', 'high']);
		expect(p.mode).toBe('pi');
		expect(p.project).toBeUndefined();
		expect(p.piArgs).toEqual(['--model', 'qwen', '--thinking', 'high']);
	});

	it('bare `pi` is a no-arg pi launch at the root', () => {
		const p = parseLaunchArgs(['pi']);
		expect(p.mode).toBe('pi');
		expect(p.project).toBeUndefined();
		expect(p.piArgs).toEqual([]);
	});

	it('honours -m before the pi token', () => {
		const p = parseLaunchArgs(['-m', 'webveil', 'pi', '--version']);
		expect(p.machine).toBe('webveil');
		expect(p.piArgs).toEqual(['--version']);
	});

	it('is the escape hatch for flags anon-pi would otherwise reject', () => {
		// `anon-pi --model x` (no project) is an unknown option; `anon-pi pi
		// --model x` is the explicit passthrough.
		expect(() => parseLaunchArgs(['--model', 'x'])).toThrow(AnonPiError);
		expect(parseLaunchArgs(['pi', '--model', 'x']).piArgs).toEqual([
			'--model',
			'x',
		]);
	});

	it('`pi` is reserved as a project name (cannot shadow the passthrough)', () => {
		// `pi` in the project position is the passthrough, never a project.
		expect(() => parseLaunchArgs(['--shell', 'pi'])).toThrow(AnonPiError);
	});
});

describe('isHeadlessPiArgs (only -p/--print is headless)', () => {
	it('is true for -p / --print', () => {
		expect(isHeadlessPiArgs(['-p', 'prompt'])).toBe(true);
		expect(isHeadlessPiArgs(['--print', 'x'])).toBe(true);
	});
	it('is FALSE for interactive forwarded args (session/model)', () => {
		expect(isHeadlessPiArgs(['--session', 'xyz'])).toBe(false);
		expect(isHeadlessPiArgs(['--model', 'foo'])).toBe(false);
		expect(isHeadlessPiArgs(undefined)).toBe(false);
		expect(isHeadlessPiArgs([])).toBe(false);
	});
});
