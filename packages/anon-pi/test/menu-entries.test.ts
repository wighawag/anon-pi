// The bare-launch menu's SELECTABLE-ENTRY assembly: turn the pure choice-list +
// usage record into an ordered list of labelled entries the raw-mode selector
// renders and dispatches. PURE (no spawn/fs): all the LOGIC (entry order, the
// used-on / new-here annotation wording) lives here so the TUI stays a thin,
// untested render/select of these entries.
import {describe, it, expect} from 'vitest';
import {
	buildMenuChoiceList,
	buildMenuEntries,
	deriveProjectUsage,
	ROOT_TOKEN,
	type MenuEntry,
	type SessionDirListing,
} from '../src/index.js';

// recon has used {alpha, beta}; scout has used {beta}; gamma is used nowhere.
const sessions: SessionDirListing = {
	recon: ['--projects-alpha--', '--projects-beta--'],
	scout: ['--projects-beta--'],
};

function entries(currentMachine: string, projects: string[]): MenuEntry[] {
	const choiceList = buildMenuChoiceList({projects});
	const usage = deriveProjectUsage({
		projects: choiceList.projects,
		currentMachine,
		sessions,
	});
	return buildMenuEntries({choiceList, usage});
}

describe('buildMenuEntries (ordered, labelled selectable entries)', () => {
	it('orders the entries: projects, then here, then + new project…, then shell', () => {
		const list = entries('recon', ['beta', 'alpha']);
		expect(list.map((e) => e.kind)).toEqual([
			'project',
			'project',
			'here',
			'new',
			'shell',
		]);
		// projects keep the choice-list order (sorted case-insensitively).
		expect(
			list.filter((e) => e.kind === 'project').map((e) => e.project),
		).toEqual(['alpha', 'beta']);
	});

	it('the here entry carries the root token as its project', () => {
		const here = entries('recon', ['alpha']).find((e) => e.kind === 'here')!;
		expect(here.project).toBe(ROOT_TOKEN);
		expect(here.project).toBe('.');
	});

	it('omits + new project… / shell when the choice-list gates them off', () => {
		const choiceList = buildMenuChoiceList({
			projects: ['alpha'],
			canNew: false,
			canShell: false,
		});
		const usage = deriveProjectUsage({
			projects: choiceList.projects,
			currentMachine: 'recon',
			sessions,
		});
		const list = buildMenuEntries({choiceList, usage});
		expect(list.map((e) => e.kind)).toEqual(['project', 'here']);
	});

	it('an empty projects root still offers here + new + shell', () => {
		const list = entries('recon', []);
		expect(list.map((e) => e.kind)).toEqual(['here', 'new', 'shell']);
	});

	it('annotates a project with the machines it has been used on', () => {
		const beta = entries('recon', ['alpha', 'beta']).find(
			(e) => e.project === 'beta',
		)!;
		// beta used on recon + scout; the current machine (recon) is NOT new for it.
		expect(beta.label).toContain('beta');
		expect(beta.label).toContain('recon');
		expect(beta.label).toContain('scout');
		expect(beta.label).not.toMatch(/new here/i);
	});

	it('flags a project the current machine is new for', () => {
		const gamma = entries('recon', ['alpha', 'gamma']).find(
			(e) => e.project === 'gamma',
		)!;
		// gamma used nowhere: new here for recon.
		expect(gamma.label).toContain('gamma');
		expect(gamma.label).toMatch(/new here/i);
	});

	it('a project used only on OTHER machines is flagged new here AND lists them', () => {
		// from nomad's view, beta is used on recon + scout but new for nomad.
		const beta = entries('nomad', ['beta']).find((e) => e.project === 'beta')!;
		expect(beta.label).toContain('recon');
		expect(beta.label).toContain('scout');
		expect(beta.label).toMatch(/new here/i);
	});

	it('an unused project on a fresh machine reads as new with no used-on list', () => {
		// gamma is used on NO machine, so from any machine it is just `new here`.
		const gamma = entries('fresh-box', ['gamma']).find(
			(e) => e.project === 'gamma',
		)!;
		expect(gamma.label).toMatch(/new here/i);
		// no machine names creep into an unused project's label.
		expect(gamma.label).not.toContain('recon');
		expect(gamma.label).not.toContain('scout');
	});

	it('the fixed entries have stable, human labels', () => {
		const list = entries('recon', ['alpha']);
		const byKind = (k: string) => list.find((e) => e.kind === k)!;
		expect(byKind('here').label).toMatch(/here/i);
		expect(byKind('new').label).toMatch(/new project/i);
		expect(byKind('shell').label).toMatch(/shell/i);
	});
});
