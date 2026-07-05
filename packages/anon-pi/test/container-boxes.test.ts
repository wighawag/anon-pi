// The PURE reader that `container enter`/`list`/`rm` use to see durable boxes:
// parseContainerBoxesJson filters `netcage ps -a --format json` down to the
// entries carrying an `anon-pi.container` label (the box's name IS the value),
// reporting each box's ref + running/stopped State. Keying on
// `anon-pi.container` (not `anon-pi.key`) is what tells a DURABLE box apart from
// a throwaway launch: the container ADR makes that label the record, so there is
// no anon-pi-side registry file. This is the seam the impure verb bodies read.
import {describe, it, expect} from 'vitest';
import {
	parseContainerBoxesJson,
	ANON_PI_CONTAINER_LABEL,
} from '../src/anon-pi.js';

describe('parseContainerBoxesJson (netcage ps -a => durable boxes)', () => {
	const box = {
		Id: 'boxid1',
		Names: ['recon-box'],
		State: 'exited',
		Labels: {
			[ANON_PI_CONTAINER_LABEL]: 'recon-box',
			'anon-pi.key': 'a2V5',
			'netcage.managed': 'true',
			'netcage.role': 'tool',
		},
	};
	const runningBox = {
		...box,
		Id: 'boxid2',
		Names: ['live-box'],
		State: 'running',
		Labels: {...box.Labels, [ANON_PI_CONTAINER_LABEL]: 'live-box'},
	};
	// A throwaway launch: carries anon-pi.key but NO anon-pi.container label.
	const throwaway = {
		Id: 'twid',
		Names: ['netcage-run-9-tool'],
		State: 'running',
		Labels: {'anon-pi.key': 'a2V5', 'netcage.managed': 'true'},
	};
	const sidecar = {
		Id: 'scid',
		Names: ['netcage-run-9-sidecar'],
		State: 'running',
		Labels: {'netcage.managed': 'true', 'netcage.role': 'sidecar'},
	};

	it('keeps ONLY anon-pi.container-labelled entries (a throwaway + sidecar are dropped)', () => {
		const r = parseContainerBoxesJson(
			JSON.stringify([box, throwaway, sidecar]),
		);
		expect(r).toEqual([{name: 'recon-box', ref: 'boxid1', running: false}]);
	});

	it('reports running vs stopped from State (both are seen, unlike the runningOnly ps reader)', () => {
		const r = parseContainerBoxesJson(JSON.stringify([box, runningBox]));
		expect(r).toEqual([
			{name: 'recon-box', ref: 'boxid1', running: false},
			{name: 'live-box', ref: 'boxid2', running: true},
		]);
	});

	it('the box name is the label VALUE (not the netcage container Names)', () => {
		const odd = {
			...box,
			Names: ['some-other-container-name'],
			Labels: {[ANON_PI_CONTAINER_LABEL]: 'my-chosen-name'},
		};
		expect(parseContainerBoxesJson(JSON.stringify([odd]))[0].name).toBe(
			'my-chosen-name',
		);
	});

	it('returns [] on bad JSON, a non-array, or an entry with no Id', () => {
		expect(parseContainerBoxesJson('not json')).toEqual([]);
		expect(parseContainerBoxesJson('{}')).toEqual([]);
		expect(
			parseContainerBoxesJson(JSON.stringify([{...box, Id: undefined}])),
		).toEqual([]);
	});
});
