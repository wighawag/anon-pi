import {describe, it, expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

// Rung-1 drift guard for README.md against the SHIPPED machines + projects
// model. It does not render or run anything; it asserts the README documents the
// landed surface and does NOT re-introduce the retired 0.4.0 vocabulary
// (import / --fresh / --ephemeral / per-workdir state / ~/.config layout). The
// prose is anchored to real, landed concepts, so a future CLI change that these
// checks contradict will fail here first (the README claim went stale).

const readme = readFileSync(
	join(dirname(fileURLToPath(import.meta.url)), '..', 'README.md'),
	'utf8',
);

describe('README documents the shipped machines + projects model', () => {
	it('names the core new concepts', () => {
		// machines + projects + the two invariant jail paths.
		expect(readme).toMatch(/\bmachine\b/i);
		expect(readme).toMatch(/\bproject\b/i);
		expect(readme).toContain('/projects');
		expect(readme).toContain('/root');
	});

	it('documents the landed launch surface (menu, --shell, --mount, -m)', () => {
		expect(readme).toContain('anon-pi init');
		expect(readme).toContain('--shell');
		expect(readme).toContain('--mount');
		expect(readme).toContain('-m <machine>');
		// the bare-launch menu.
		expect(readme).toMatch(/\bmenu\b/i);
	});

	it('documents throwaway-always and the machine/data verbs', () => {
		// throwaway is the ONLY behaviour now; --keep/--rm are retired.
		expect(readme).toMatch(/throwaway/i);
		expect(readme).toContain('--delete-home');
		expect(readme).toContain('--delete-project');
		expect(readme).toContain('anon-pi machine');
	});

	it('does NOT present the retired --keep/--rm as a live launch flag', () => {
		// They may appear in the migration note as REMOVED, but never as a runnable
		// launch flag in a code example (which would read as current).
		for (const gone of ['--keep', '--rm']) {
			expect(
				fencedCode.some((b) =>
					new RegExp(`\\banon-pi\\b[^\\n]*\\s${escape(gone)}\\b`).test(b),
				),
				`retired \`${gone}\` must not appear as a launch flag in a code example`,
			).toBe(false);
		}
	});

	it('documents the ~/.anon-pi/ layout, not the ~/.config one', () => {
		expect(readme).toContain('~/.anon-pi/');
		expect(readme).toContain('config.json');
		// the old home; only allowed in the migration note's "delete it" guidance.
		expect(readme).toContain('~/.config/anon-pi');
	});

	it('keeps the forced-egress honesty (evidence, never a provider label)', () => {
		expect(readme).toMatch(/socks5h/i);
		expect(readme).toMatch(/fail-closed/i);
		expect(readme).toMatch(/exit ip/i);
	});
});

describe('README carries a 0.4.0 migration note', () => {
	it('has a migration section', () => {
		expect(readme).toMatch(/migrat/i);
	});

	it('documents that a bare positional is now a PROJECT, not a host path', () => {
		expect(readme).toMatch(/bare positional is now a project/i);
	});

	it('documents the removed verbs/flags and their replacements', () => {
		// The retired surface is named (as REMOVED) in the migration note.
		for (const gone of ['import', '--fresh', '--ephemeral', '--keep', '--rm']) {
			expect(readme, `migration note should mention ${gone}`).toContain(gone);
		}
		// old per-workdir state directory shape, documented as not-migrated.
		expect(readme).toMatch(/state\/<slug>\/|state\/<slug>|<slug>\//);
	});

	it('does NOT present the retired flags as a live shell example', () => {
		// The removed flags may appear in migration PROSE ("`anon-pi import` is
		// GONE"), but must never reappear as a runnable invocation inside a fenced
		// code block (a copy-paste usage example), which would read as current.
		for (const cmd of ['import', '--fresh', '--ephemeral']) {
			expect(
				fencedCode.some((b) =>
					new RegExp(`\\banon-pi\\s+${escape(cmd)}\\b`).test(b),
				),
				`retired \`anon-pi ${cmd}\` must not appear as a shell example`,
			).toBe(false);
		}
	});
});

/** Every fenced code block body in the README (between triple-backtick fences). */
const fencedCode: string[] = (() => {
	const blocks: string[] = [];
	const re = /```[^\n]*\n([\s\S]*?)```/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(readme)) !== null) blocks.push(m[1]);
	return blocks;
})();

/** Escape a literal for embedding in a RegExp. */
function escape(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
