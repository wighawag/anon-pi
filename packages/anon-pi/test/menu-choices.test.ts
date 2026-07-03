// The bare-launch menu choice-list + per-machine project-usage record.
//
// PURE (no spawn/fs): the choice-list is computed from a SUPPLIED projects-root
// listing, and the usage record from a SUPPLIED per-machine session-dir listing
// (the CLI does the real dir reads; here we inject a fixture tree). No real
// ~/.anon-pi or ~/.pi is touched.
//
// The usage record is DERIVED from the presence of pi session dirs at
// machines/<M>/home/.pi/agent/sessions/<slug>/, where <slug> is pi's OWN cwd
// convention over /projects/<name> (pathSlug). No marker file.
import {describe, it, expect} from 'vitest';
import {
	buildMenuChoiceList,
	deriveProjectUsage,
	projectSessionSlug,
	ROOT_TOKEN,
	pathSlug,
	type MenuChoiceList,
	type ProjectUsage,
	type SessionDirListing,
} from '../src/index.js';

// A fixture machines/*/home/.pi/agent/sessions/ tree, expressed as the slug set
// present in each machine home (what the CLI derives by reading the sessions
// dir). recon has used {alpha, beta}; scout has used {beta}; nomad has used none.
const sessions: SessionDirListing = {
	recon: [projectSessionSlug('alpha'), projectSessionSlug('beta')],
	scout: [projectSessionSlug('beta')],
	nomad: [],
};

describe('projectSessionSlug (pi cwd convention over /projects/<name>)', () => {
	it('is pathSlug of the jail cwd /projects/<name> (machine-invariant)', () => {
		// pi keys a session by its launch cwd; the project cwd is /projects/<name>,
		// so the slug is the SAME on every machine (files are global).
		expect(projectSessionSlug('alpha')).toBe(pathSlug('/projects/alpha'));
		expect(projectSessionSlug('alpha')).toBe('--projects-alpha--');
	});

	it('validates the project name (rejects traversal / separators)', () => {
		expect(() => projectSessionSlug('../x')).toThrow();
		expect(() => projectSessionSlug('a/b')).toThrow();
	});
});

describe('buildMenuChoiceList (projects + here/new/shell affordances)', () => {
	const projects = ['alpha', 'beta', 'gamma'];

	it('lists the supplied projects and exposes canShell + canNew', () => {
		const menu: MenuChoiceList = buildMenuChoiceList({projects});
		expect(menu.projects).toEqual(['alpha', 'beta', 'gamma']);
		expect(menu.canShell).toBe(true);
		expect(menu.canNew).toBe(true);
	});

	it('includes the "." here entry as a scratch pi at the root', () => {
		const menu = buildMenuChoiceList({projects});
		expect(menu.here).toBe(ROOT_TOKEN);
		expect(menu.here).toBe('.');
	});

	it('sorts the project names (stable, case-insensitive) for a stable menu', () => {
		const menu = buildMenuChoiceList({projects: ['Beta', 'alpha', 'gamma']});
		expect(menu.projects).toEqual(['alpha', 'Beta', 'gamma']);
	});

	it('drops non-project entries (leading-dot / traversal / bad names)', () => {
		// A real dir read may surface dotfiles or odd entries; only folder-safe
		// project names become menu entries (the "." here entry is separate).
		const menu = buildMenuChoiceList({
			projects: ['alpha', '.git', '..', 'a/b', 'ok_2'],
		});
		expect(menu.projects).toEqual(['alpha', 'ok_2']);
	});

	it('an empty projects root still offers here / new / shell', () => {
		const menu = buildMenuChoiceList({projects: []});
		expect(menu.projects).toEqual([]);
		expect(menu.here).toBe('.');
		expect(menu.canShell).toBe(true);
		expect(menu.canNew).toBe(true);
	});
});

describe('deriveProjectUsage (per-machine, from session-dir presence)', () => {
	it('maps each project to the machines that have used it (sorted)', () => {
		const usage = deriveProjectUsage({
			projects: ['alpha', 'beta', 'gamma'],
			currentMachine: 'recon',
			sessions,
		});
		const byName = (n: string): ProjectUsage =>
			usage.find((u) => u.project === n)!;
		expect(byName('alpha').machines).toEqual(['recon']);
		expect(byName('beta').machines).toEqual(['recon', 'scout']);
		expect(byName('gamma').machines).toEqual([]);
	});

	it('preserves the supplied project order', () => {
		const usage = deriveProjectUsage({
			projects: ['gamma', 'beta', 'alpha'],
			currentMachine: 'recon',
			sessions,
		});
		expect(usage.map((u) => u.project)).toEqual(['gamma', 'beta', 'alpha']);
	});

	it('flags currentMachineIsNew when this machine has no session dir yet', () => {
		const usage = deriveProjectUsage({
			projects: ['alpha', 'beta', 'gamma'],
			currentMachine: 'recon',
			sessions,
		});
		const byName = (n: string): ProjectUsage =>
			usage.find((u) => u.project === n)!;
		// recon has used alpha + beta, but NOT gamma.
		expect(byName('alpha').currentMachineIsNew).toBe(false);
		expect(byName('beta').currentMachineIsNew).toBe(false);
		expect(byName('gamma').currentMachineIsNew).toBe(true);
	});

	it('a project used only on OTHER machines is still new for the current one', () => {
		// scout used beta; from recon's view beta is used-elsewhere but current-new
		// is false (recon used it too). From nomad's view beta is used-elsewhere AND
		// new for nomad.
		const usage = deriveProjectUsage({
			projects: ['beta'],
			currentMachine: 'nomad',
			sessions,
		});
		expect(usage[0].machines).toEqual(['recon', 'scout']);
		expect(usage[0].currentMachineIsNew).toBe(true);
	});

	it('a brand-new current machine (no sessions listing entry) is new for all', () => {
		const usage = deriveProjectUsage({
			projects: ['alpha', 'beta'],
			currentMachine: 'fresh-box',
			sessions,
		});
		expect(usage.every((u) => u.currentMachineIsNew)).toBe(true);
	});

	it('the same project shared across machines is recognised on each (machine-invariant slug)', () => {
		// beta's slug is identical in recon + scout homes, so both are credited.
		expect(sessions.recon).toContain(projectSessionSlug('alpha'));
		expect(sessions.scout).toContain(projectSessionSlug('beta'));
		expect(projectSessionSlug('beta')).toBe('--projects-beta--');
	});

	it('validates project names (rejects traversal)', () => {
		expect(() =>
			deriveProjectUsage({
				projects: ['../escape'],
				currentMachine: 'recon',
				sessions,
			}),
		).toThrow();
	});
});
