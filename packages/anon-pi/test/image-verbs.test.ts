// The PURE parts of the `image {snapshot,list}` noun (ADR-0003): the argv parser
// (a testable `image <verb> …` grammar with the reserved-name guard), the clean
// image-tag derivation, the provenance-label BUILD (the `LABEL k=v` change
// instructions a `netcage commit -c` bakes), and the provenance READ-BACK parse
// (label map -> the anon-pi provenance fields).
//
// PURE (no spawn/fs): argv in -> ImageCommand out (or an AnonPiError); label
// inputs in -> strings/fields out. The CLI wires these to the real netcage
// commit / images / inspect I/O (covered by cli-image.test.ts).
import {describe, it, expect} from 'vitest';
import {
	AnonPiError,
	parseImageArgs,
	snapshotImageTag,
	snapshotProvenanceLabels,
	parseImageProvenance,
	PROVENANCE_LABEL_SOURCE_MACHINE,
	PROVENANCE_LABEL_SOURCE_IMAGE,
	PROVENANCE_LABEL_SNAPSHOT_AT,
} from '../src/index.js';

describe('parseImageArgs — the verb grammar', () => {
	it('list takes no args', () => {
		expect(parseImageArgs(['list'])).toEqual({verb: 'list'});
	});

	it('list rejects extra args', () => {
		expect(() => parseImageArgs(['list', 'x'])).toThrow(AnonPiError);
	});

	it('snapshot <name>: the sole positional is the image name; machine undefined', () => {
		expect(parseImageArgs(['snapshot', 'webscan'])).toEqual({
			verb: 'snapshot',
			name: 'webscan',
			machine: undefined,
			createMachine: undefined,
			updateMachine: undefined,
		});
	});

	it('snapshot -m/--machine is an OPTIONAL filter (validated), not a source', () => {
		expect(parseImageArgs(['snapshot', 'webscan', '-m', 'recon'])).toEqual({
			verb: 'snapshot',
			name: 'webscan',
			machine: 'recon',
			createMachine: undefined,
			updateMachine: undefined,
		});
		expect(
			parseImageArgs(['snapshot', 'webscan', '--machine', 'recon']).machine,
		).toBe('recon');
	});

	it('snapshot --create-machine <m> is a validated machine name', () => {
		expect(
			parseImageArgs(['snapshot', 'webscan', '--create-machine', 'toolbox']),
		).toEqual({
			verb: 'snapshot',
			name: 'webscan',
			machine: undefined,
			createMachine: 'toolbox',
			updateMachine: undefined,
		});
	});

	it('snapshot --update-machine <m> is a validated machine name', () => {
		expect(
			parseImageArgs(['snapshot', 'webscan', '--update-machine', 'toolbox']),
		).toEqual({
			verb: 'snapshot',
			name: 'webscan',
			machine: undefined,
			createMachine: undefined,
			updateMachine: 'toolbox',
		});
	});

	it('--create-machine and --update-machine are mutually exclusive', () => {
		expect(() =>
			parseImageArgs([
				'snapshot',
				'webscan',
				'--create-machine',
				'a',
				'--update-machine',
				'b',
			]),
		).toThrow(/mutually exclusive/);
	});

	it('--update-machine needs a name and validates it', () => {
		expect(() => parseImageArgs(['snapshot', 'a', '--update-machine'])).toThrow(
			AnonPiError,
		);
		expect(() =>
			parseImageArgs(['snapshot', 'a', '--update-machine', 'x/y']),
		).toThrow(AnonPiError);
	});

	it('snapshot -m + --create-machine compose', () => {
		expect(
			parseImageArgs([
				'snapshot',
				'webscan',
				'-m',
				'recon',
				'--create-machine',
				'toolbox',
			]),
		).toEqual({
			verb: 'snapshot',
			name: 'webscan',
			machine: 'recon',
			createMachine: 'toolbox',
			updateMachine: undefined,
		});
	});

	it('rejects a missing name, an extra positional, empty flags, and bad names', () => {
		expect(() => parseImageArgs(['snapshot'])).toThrow(/needs a <name>/);
		expect(() => parseImageArgs(['snapshot', 'a', 'b'])).toThrow(/got extra/);
		expect(() => parseImageArgs(['snapshot', 'a', '-m'])).toThrow(AnonPiError);
		expect(() => parseImageArgs(['snapshot', 'a', '--create-machine'])).toThrow(
			AnonPiError,
		);
		expect(() => parseImageArgs(['snapshot', 'a/b'])).toThrow(
			/invalid machine name/,
		);
		expect(() => parseImageArgs(['snapshot', 'ok', '-m', 'a/b'])).toThrow(
			AnonPiError,
		);
	});

	it('an unknown or missing subcommand fails clearly', () => {
		expect(() => parseImageArgs([])).toThrow(AnonPiError);
		expect(() => parseImageArgs(['bogus'])).toThrow(/unknown image subcommand/);
	});

	it('rejects an unknown flag', () => {
		expect(() => parseImageArgs(['snapshot', 'a', '--bogus'])).toThrow(
			/unknown option/,
		);
	});
});

describe('snapshotImageTag (the clean :latest tag)', () => {
	it('is anon-pi/<name>:latest', () => {
		expect(snapshotImageTag('webscan')).toBe('anon-pi/webscan:latest');
	});

	it('validates the name (traversal / reserved guard)', () => {
		expect(() => snapshotImageTag('a/b')).toThrow(AnonPiError);
		expect(() => snapshotImageTag('image')).toThrow(/reserved/);
	});
});

describe('snapshotProvenanceLabels (the LABEL change instructions)', () => {
	it('builds all three labels when every field is known', () => {
		expect(
			snapshotProvenanceLabels({
				sourceMachine: 'recon',
				sourceImage: 'anon-pi/webscan:latest',
				at: '2026-07-05T09:05:07.000Z',
			}),
		).toEqual([
			`LABEL ${PROVENANCE_LABEL_SOURCE_MACHINE}=recon`,
			`LABEL ${PROVENANCE_LABEL_SOURCE_IMAGE}=anon-pi/webscan:latest`,
			`LABEL ${PROVENANCE_LABEL_SNAPSHOT_AT}=2026-07-05T09:05:07.000Z`,
		]);
	});

	it('OMITS a label whose value is undefined/empty (a missing label beats a wrong one)', () => {
		expect(
			snapshotProvenanceLabels({
				sourceMachine: 'recon',
				sourceImage: undefined,
				at: '2026-07-05T09:05:07.000Z',
			}),
		).toEqual([
			`LABEL ${PROVENANCE_LABEL_SOURCE_MACHINE}=recon`,
			`LABEL ${PROVENANCE_LABEL_SNAPSHOT_AT}=2026-07-05T09:05:07.000Z`,
		]);
		// an empty-string source-machine is also omitted.
		expect(
			snapshotProvenanceLabels({sourceMachine: '', at: '2026-07-05T00:00:00Z'}),
		).toEqual([`LABEL ${PROVENANCE_LABEL_SNAPSHOT_AT}=2026-07-05T00:00:00Z`]);
	});
});

describe('parseImageProvenance (read labels back off an image)', () => {
	it('extracts the three anon-pi provenance fields', () => {
		expect(
			parseImageProvenance({
				[PROVENANCE_LABEL_SOURCE_MACHINE]: 'recon',
				[PROVENANCE_LABEL_SOURCE_IMAGE]: 'anon-pi/webscan:latest',
				[PROVENANCE_LABEL_SNAPSHOT_AT]: '2026-07-05T09:05:07.000Z',
				'other.label': 'ignored',
			}),
		).toEqual({
			sourceMachine: 'recon',
			sourceImage: 'anon-pi/webscan:latest',
			snapshotAt: '2026-07-05T09:05:07.000Z',
		});
	});

	it('a missing label => an undefined field (tolerant, no throw)', () => {
		expect(parseImageProvenance({})).toEqual({
			sourceMachine: undefined,
			sourceImage: undefined,
			snapshotAt: undefined,
		});
		expect(parseImageProvenance(null)).toEqual({
			sourceMachine: undefined,
			sourceImage: undefined,
			snapshotAt: undefined,
		});
		expect(parseImageProvenance(undefined)).toEqual({
			sourceMachine: undefined,
			sourceImage: undefined,
			snapshotAt: undefined,
		});
	});

	it('drops non-string / empty values rather than throwing', () => {
		expect(
			parseImageProvenance({
				[PROVENANCE_LABEL_SOURCE_MACHINE]: 42 as unknown as string,
				[PROVENANCE_LABEL_SOURCE_IMAGE]: '',
				[PROVENANCE_LABEL_SNAPSHOT_AT]: '2026-07-05T00:00:00Z',
			}),
		).toEqual({
			sourceMachine: undefined,
			sourceImage: undefined,
			snapshotAt: '2026-07-05T00:00:00Z',
		});
	});
});
