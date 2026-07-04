// The PURE parts of the `machine {create,list,set-image,rm}` verbs: the argv
// parser (a testable `machine <verb> …` grammar with the reserved-name guard),
// the machine.json serialiser, and the set-image compatibility WARNING wording.
//
// PURE (no spawn/fs): argv in -> MachineCommand out (or an AnonPiError); config
// in -> JSON string out. The CLI wires these to the real filesystem + the rm
// confirm/`--yes`/non-TTY discipline (covered by cli-machine.test.ts).
import {describe, it, expect} from 'vitest';
import {
	AnonPiError,
	parseMachineArgs,
	serializeMachineJson,
	setImageWarning,
} from '../src/index.js';

describe('parseMachineArgs — the verb grammar', () => {
	it('list takes no args', () => {
		expect(parseMachineArgs(['list'])).toEqual({verb: 'list'});
	});

	it('list rejects extra args', () => {
		expect(() => parseMachineArgs(['list', 'x'])).toThrow(AnonPiError);
	});

	it('create <name> (no image) validates the name and leaves image undefined', () => {
		expect(parseMachineArgs(['create', 'recon'])).toEqual({
			verb: 'create',
			name: 'recon',
			image: undefined,
		});
	});

	it('create <name> --image <ref> pins the image', () => {
		expect(
			parseMachineArgs(['create', 'recon', '--image', 'my/pi:tag']),
		).toEqual({
			verb: 'create',
			name: 'recon',
			image: 'my/pi:tag',
		});
	});

	it('create rejects a missing name, an unknown flag, and an empty --image', () => {
		expect(() => parseMachineArgs(['create'])).toThrow(AnonPiError);
		expect(() => parseMachineArgs(['create', 'recon', '--bogus'])).toThrow(
			AnonPiError,
		);
		expect(() => parseMachineArgs(['create', 'recon', '--image'])).toThrow(
			AnonPiError,
		);
	});

	it('create rejects an invalid machine name (reserved-name / traversal guard)', () => {
		expect(() => parseMachineArgs(['create', 'a/b'])).toThrow(
			/invalid machine name/,
		);
		expect(() => parseMachineArgs(['create', '..'])).toThrow(AnonPiError);
		expect(() => parseMachineArgs(['create', '.'])).toThrow(AnonPiError);
	});

	it('set-image <name> <ref> validates the name and takes the ref', () => {
		expect(parseMachineArgs(['set-image', 'recon', 'my/pi:2'])).toEqual({
			verb: 'set-image',
			name: 'recon',
			image: 'my/pi:2',
		});
	});

	it('set-image rejects a missing ref or an extra positional', () => {
		expect(() => parseMachineArgs(['set-image', 'recon'])).toThrow(AnonPiError);
		expect(() => parseMachineArgs(['set-image', 'recon', 'a', 'b'])).toThrow(
			AnonPiError,
		);
	});

	it('rm <name> defaults yes=false; --yes / -y set it', () => {
		expect(parseMachineArgs(['rm', 'recon'])).toEqual({
			verb: 'rm',
			name: 'recon',
			yes: false,
		});
		expect(parseMachineArgs(['rm', 'recon', '--yes'])).toEqual({
			verb: 'rm',
			name: 'recon',
			yes: true,
		});
		expect(parseMachineArgs(['rm', '-y', 'recon'])).toEqual({
			verb: 'rm',
			name: 'recon',
			yes: true,
		});
	});

	it('rm rejects a missing name and an unknown flag', () => {
		expect(() => parseMachineArgs(['rm'])).toThrow(AnonPiError);
		expect(() => parseMachineArgs(['rm', 'recon', '--force'])).toThrow(
			AnonPiError,
		);
	});

	it('an unknown or missing subcommand fails clearly', () => {
		expect(() => parseMachineArgs([])).toThrow(AnonPiError);
		expect(() => parseMachineArgs(['bogus'])).toThrow(
			/unknown machine subcommand/,
		);
	});
});

describe('serializeMachineJson', () => {
	it('pins the image, tab-indented with a trailing newline', () => {
		const s = serializeMachineJson({image: 'my/pi:tag'});
		expect(s).toBe('{\n\t"image": "my/pi:tag"\n}\n');
	});

	it('preserves a per-machine projects override (so a re-pin does not drop it)', () => {
		const parsed = JSON.parse(
			serializeMachineJson({image: 'my/pi:2', projects: '/dev/anon'}),
		);
		expect(parsed).toEqual({image: 'my/pi:2', projects: '/dev/anon'});
	});

	it('drops empty/whitespace fields', () => {
		expect(
			JSON.parse(serializeMachineJson({image: '  ', projects: ''})),
		).toEqual({});
	});
});

describe('setImageWarning', () => {
	it('names the machine, the from->to images, and does NOT auto-reseed', () => {
		const w = setImageWarning('recon', 'old/pi:1', 'new/pi:2');
		expect(w).toContain('recon');
		expect(w).toContain('old/pi:1');
		expect(w).toContain('new/pi:2');
		expect(w).toContain('WARNING');
		expect(w).toContain('NOT reseeded');
	});

	it('renders (none) when there was no prior image', () => {
		expect(setImageWarning('recon', undefined, 'new/pi:2')).toContain('(none)');
	});
});
