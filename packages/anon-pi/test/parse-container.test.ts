// The PURE grammar of the `container {create,enter,list,rm}` noun: durable named
// boxes (an EXPLICIT reintroduction of the retired `--keep`, per the container
// ADR that supersedes ADR-0004's "lost capability" note). `create` freezes the
// box's image + cwd at create, so it takes the cwd mode word (a project token or
// `--shell`); `enter` takes ONLY the name (image + cwd are frozen) and REFUSES
// `-i` / a project / `--shell` grammatically. `list` takes no args; `rm` takes a
// name + optional `--yes`.
//
// PURE (no spawn/fs): argv in -> ContainerCommand out (or an AnonPiError). The
// impure verb bodies (create/enter, list/rm) land in the sibling tasks; the
// dispatch + `--help` are wired in cli.ts (cli-container.test.ts covers those).
import {describe, it, expect} from 'vitest';
import {
	AnonPiError,
	parseContainerArgs,
	RESERVED_NAMES,
	ROOT_TOKEN,
	validateName,
} from '../src/index.js';

describe('parseContainerArgs — the verb grammar', () => {
	it('list takes no args', () => {
		expect(parseContainerArgs(['list'])).toEqual({verb: 'list'});
	});

	it('list rejects extra args', () => {
		expect(() => parseContainerArgs(['list', 'x'])).toThrow(AnonPiError);
	});

	it('a missing verb errors', () => {
		expect(() => parseContainerArgs([])).toThrow(AnonPiError);
	});

	it('an unknown verb errors with the verb list', () => {
		expect(() => parseContainerArgs(['bogus'])).toThrow(
			/unknown container subcommand/,
		);
	});
});

describe('parseContainerArgs — create', () => {
	it('create <name> defaults to no cwd mode word (menu-shaped later)', () => {
		expect(parseContainerArgs(['create', 'recon-box'])).toEqual({
			verb: 'create',
			name: 'recon-box',
			machine: undefined,
			image: undefined,
			mountParent: undefined,
			shell: false,
			project: undefined,
		});
	});

	it('create requires an explicit <name>', () => {
		expect(() => parseContainerArgs(['create'])).toThrow(/needs a <name>/);
	});

	it('create takes a project token as the (frozen) cwd mode word', () => {
		expect(parseContainerArgs(['create', 'box', 'myproj']).project).toBe(
			'myproj',
		);
	});

	it('create takes the `.` root token as the cwd mode word', () => {
		expect(parseContainerArgs(['create', 'box', '.']).project).toBe(ROOT_TOKEN);
	});

	it('create takes --shell as the cwd mode word (mutually with a project)', () => {
		const cmd = parseContainerArgs(['create', 'box', '--shell']);
		expect(cmd.verb).toBe('create');
		if (cmd.verb === 'create') {
			expect(cmd.shell).toBe(true);
			expect(cmd.project).toBeUndefined();
		}
	});

	it('create rejects both a project and --shell (one cwd mode word)', () => {
		expect(() =>
			parseContainerArgs(['create', 'box', 'myproj', '--shell']),
		).toThrow(AnonPiError);
	});

	it('create takes -i / -m / --mount like a launch', () => {
		expect(
			parseContainerArgs([
				'create',
				'box',
				'-i',
				'anon-pi/webscan:latest',
				'-m',
				'recon',
				'--mount',
				'/host/dev',
				'sub',
			]),
		).toEqual({
			verb: 'create',
			name: 'box',
			machine: 'recon',
			image: 'anon-pi/webscan:latest',
			mountParent: '/host/dev',
			shell: false,
			project: 'sub',
		});
	});

	it('create rejects an unknown flag', () => {
		expect(() => parseContainerArgs(['create', 'box', '--bogus'])).toThrow(
			/unknown option/,
		);
	});

	it('create rejects a second project positional', () => {
		expect(() => parseContainerArgs(['create', 'box', 'a', 'b'])).toThrow(
			/got extra/,
		);
	});

	it('create validates the name via validateName (reserved/traversal guard)', () => {
		expect(() => parseContainerArgs(['create', 'a/b'])).toThrow(AnonPiError);
		expect(() => parseContainerArgs(['create', 'container'])).toThrow(
			AnonPiError,
		);
	});

	it('-m / -i missing their argument errors', () => {
		expect(() => parseContainerArgs(['create', 'box', '-m'])).toThrow(
			AnonPiError,
		);
		expect(() => parseContainerArgs(['create', 'box', '-i'])).toThrow(
			AnonPiError,
		);
		expect(() => parseContainerArgs(['create', 'box', '--mount'])).toThrow(
			AnonPiError,
		);
	});
});

describe('parseContainerArgs — enter (name only; image + cwd frozen)', () => {
	it('enter <name> parses to just the name', () => {
		expect(parseContainerArgs(['enter', 'recon-box'])).toEqual({
			verb: 'enter',
			name: 'recon-box',
		});
	});

	it('enter requires a <name>', () => {
		expect(() => parseContainerArgs(['enter'])).toThrow(/needs a <name>/);
	});

	it('enter REFUSES -i (the image is frozen at create) with a loud error', () => {
		expect(() =>
			parseContainerArgs(['enter', 'box', '-i', 'anon-pi/x:latest']),
		).toThrow(/FROZEN at create/);
	});

	it('enter REFUSES a project token (the cwd is frozen at create)', () => {
		expect(() => parseContainerArgs(['enter', 'box', 'myproj'])).toThrow(
			/FROZEN at create/,
		);
	});

	it('enter REFUSES --shell (the cwd is frozen at create)', () => {
		expect(() => parseContainerArgs(['enter', 'box', '--shell'])).toThrow(
			/FROZEN at create/,
		);
	});

	it('the enter refusal points at re-create / image snapshot', () => {
		expect(() => parseContainerArgs(['enter', 'box', '-i', 'x'])).toThrow(
			/image snapshot|re-create/,
		);
	});
});

describe('parseContainerArgs — rm', () => {
	it('rm <name> parses with yes=false by default', () => {
		expect(parseContainerArgs(['rm', 'box'])).toEqual({
			verb: 'rm',
			name: 'box',
			yes: false,
		});
	});

	it('rm --yes / -y sets yes=true', () => {
		expect(parseContainerArgs(['rm', 'box', '--yes']).verb).toBe('rm');
		expect(
			(parseContainerArgs(['rm', 'box', '--yes']) as {yes: boolean}).yes,
		).toBe(true);
		expect(
			(parseContainerArgs(['rm', '-y', 'box']) as {yes: boolean}).yes,
		).toBe(true);
	});

	it('rm requires a <name>', () => {
		expect(() => parseContainerArgs(['rm'])).toThrow(/needs a <name>/);
	});

	it('rm rejects an extra positional', () => {
		expect(() => parseContainerArgs(['rm', 'a', 'b'])).toThrow(/got extra/);
	});
});

describe('container is a reserved noun word', () => {
	it('`container` is in RESERVED_NAMES (a project cannot shadow the subcommand)', () => {
		expect(RESERVED_NAMES).toContain('container');
	});

	it('validateName refuses a project/machine named `container`', () => {
		expect(() => validateName('container', 'project')).toThrow(AnonPiError);
		expect(() => validateName('container', 'machine')).toThrow(AnonPiError);
	});
});
