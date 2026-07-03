// The run-vs-start decision rule for kept (netcage.managed) containers.
//
// PURE (no spawn/fs): given a resolved LaunchIntent and a SUPPLIED listing of
// kept containers (the netcage query is the CLI's job; here we inject its
// result), decide whether a `--keep` launch should `netcage start` an existing
// kept container (match present) or `netcage run` (without `--rm`) a fresh one
// (match absent). A `--rm` (throwaway) launch always resolves to a fresh `run`.
//
// The match key is derived from the (machine, projects-root, project) identity
// (netcage's `netcage.managed` label IS the record; anon-pi invents no registry
// file). No real netcage/podman is invoked.
import {describe, it, expect} from 'vitest';
import {
	keptContainerKey,
	resolveRunVsStart,
	type KeptContainer,
	type LaunchIntent,
	type Machine,
} from '../src/index.js';

const machine: Machine = {
	name: 'recon',
	home: '/tmp/anon-pi-home/machines/recon/home',
	image: 'my/pi:tag',
};

const projectsRoot = '/tmp/anon-pi-home/projects';

// A base --keep pi <project> intent with the forced-egress inputs supplied.
const baseIntent = (over: Partial<LaunchIntent> = {}): LaunchIntent => ({
	machine,
	mode: 'pi',
	projectsRoot,
	project: 'recon',
	keep: true,
	proxy: 'socks5h://127.0.0.1:9050',
	llmDirect: '192.168.1.150:8080',
	...over,
});

// A kept-container listing entry keyed for a given intent (so a fixture listing
// can carry the SAME key the decision computes for a matching launch).
const kept = (intent: LaunchIntent, ref: string): KeptContainer => ({
	key: keptContainerKey(intent),
	ref,
});

describe('keptContainerKey — the match key from (machine, projects-root, project)', () => {
	it('is stable for the same identity', () => {
		expect(keptContainerKey(baseIntent())).toBe(keptContainerKey(baseIntent()));
	});

	it('differs when the MACHINE differs', () => {
		const a = keptContainerKey(baseIntent());
		const b = keptContainerKey(
			baseIntent({machine: {...machine, name: 'other'}}),
		);
		expect(a).not.toBe(b);
	});

	it('differs when the PROJECTS-ROOT differs', () => {
		const a = keptContainerKey(baseIntent());
		const b = keptContainerKey(baseIntent({projectsRoot: '/tmp/other-root'}));
		expect(a).not.toBe(b);
	});

	it('differs when the PROJECT differs (via the cwd it resolves)', () => {
		const a = keptContainerKey(baseIntent({project: 'recon'}));
		const b = keptContainerKey(baseIntent({project: 'other'}));
		expect(a).not.toBe(b);
	});

	it('distinguishes the root token `.` from a same-named project', () => {
		const root = keptContainerKey(baseIntent({project: '.'}));
		const named = keptContainerKey(baseIntent({project: 'recon'}));
		expect(root).not.toBe(named);
	});

	it('differs when --mount re-roots the launch (distinct parent identity)', () => {
		const plain = keptContainerKey(baseIntent({project: 'sub'}));
		const mounted = keptContainerKey(
			baseIntent({project: 'sub', mountParent: '/host/dev'}),
		);
		expect(plain).not.toBe(mounted);
	});

	it('is independent of --keep/--rm and the forced-egress inputs (identity only)', () => {
		// The key names WHICH kept container an identity maps to; it must not change
		// with the throwaway flag or the proxy/llm (those are not part of identity).
		const a = keptContainerKey(baseIntent({keep: true}));
		const b = keptContainerKey(
			baseIntent({
				keep: false,
				proxy: 'socks5h://127.0.0.1:1080',
				llmDirect: '10.0.0.5:1234',
			}),
		);
		expect(a).toBe(b);
	});

	it('is independent of forwarded pi args (same conversation/container identity)', () => {
		const a = keptContainerKey(baseIntent());
		const b = keptContainerKey(baseIntent({piArgs: ['-p', 'do a thing']}));
		expect(a).toBe(b);
	});
});

describe('resolveRunVsStart — the pure decision', () => {
	it('--rm (throwaway) ALWAYS resolves to a fresh run, even if a match is present', () => {
		const intent = baseIntent({keep: false});
		// a listing that WOULD match if we consulted it under --keep
		const listing: KeptContainer[] = [kept(baseIntent({keep: true}), 'c-123')];
		const d = resolveRunVsStart(intent, listing);
		expect(d.action).toBe('run');
		expect('ref' in d).toBe(false);
	});

	it('--rm short-circuits WITHOUT consulting the listing at all', () => {
		// even an empty/garbage listing is irrelevant under --rm
		expect(resolveRunVsStart(baseIntent({keep: false}), []).action).toBe('run');
	});

	it('--keep with a MATCHING kept container present resolves to start (with its ref)', () => {
		const intent = baseIntent();
		const listing: KeptContainer[] = [kept(intent, 'c-abc')];
		const d = resolveRunVsStart(intent, listing);
		expect(d.action).toBe('start');
		if (d.action === 'start') expect(d.ref).toBe('c-abc');
	});

	it('--keep with NO matching kept container resolves to run (without --rm)', () => {
		const intent = baseIntent();
		// a listing with a DIFFERENT identity present must not match
		const other = kept(baseIntent({project: 'other'}), 'c-other');
		const d = resolveRunVsStart(intent, [other]);
		expect(d.action).toBe('run');
	});

	it('--keep with an EMPTY listing resolves to run', () => {
		expect(resolveRunVsStart(baseIntent(), []).action).toBe('run');
	});

	it('picks the entry whose key matches this launch out of a mixed listing', () => {
		const intent = baseIntent({project: 'recon'});
		const listing: KeptContainer[] = [
			kept(baseIntent({project: 'other'}), 'c-other'),
			kept(baseIntent({project: 'recon'}), 'c-recon'),
			kept(baseIntent({project: '.'}), 'c-root'),
		];
		const d = resolveRunVsStart(intent, listing);
		expect(d.action).toBe('start');
		if (d.action === 'start') expect(d.ref).toBe('c-recon');
	});

	it('does NOT start a container from a DIFFERENT machine with the same project', () => {
		const intent = baseIntent({project: 'recon'});
		const otherMachine = kept(
			baseIntent({project: 'recon', machine: {...machine, name: 'other'}}),
			'c-other-machine',
		);
		const d = resolveRunVsStart(intent, [otherMachine]);
		expect(d.action).toBe('run');
	});

	it('does NOT start a container from a DIFFERENT projects-root with the same project', () => {
		const intent = baseIntent({project: 'recon'});
		const otherRoot = kept(
			baseIntent({project: 'recon', projectsRoot: '/tmp/other-root'}),
			'c-other-root',
		);
		const d = resolveRunVsStart(intent, [otherRoot]);
		expect(d.action).toBe('run');
	});
});
