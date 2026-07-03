import {describe, it, expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

// Rung-1 structural test for the shipped base image Dockerfile.pi. It does NOT
// build the image; it asserts the load-bearing invariants that must AGREE with
// the pure module's RunPlan paths (launch-run-plan-resolution): the default cwd
// (WORKDIR) is the projects root /projects, and the staged trust.json trusts the
// two cwd roots pi can launch into so pi never prompts on the mounted project:
//   - /projects : the projects-root cwd (CONTAINER_PROJECTS_ROOT)
//   - /work     : the distinct --mount root cwd (CONTAINER_MOUNT_ROOT)
// The trust.json is STAGED in /opt/anon-pi-seed/agent (never the mounted
// ~/.pi/agent, which the persistent home would shadow) and promoted into the
// machine home on first launch.

const dockerfile = readFileSync(
	join(dirname(fileURLToPath(import.meta.url)), '..', 'Dockerfile.pi'),
	'utf8',
);

describe('Dockerfile.pi structure', () => {
	it('starts FROM a node base and installs pi via the official npm package', () => {
		expect(dockerfile).toMatch(/^FROM node:/m);
		expect(dockerfile).toContain('@earendil-works/pi-coding-agent');
	});

	it('sets WORKDIR to the projects root /projects (pi default cwd)', () => {
		// The default cwd must be /projects (the projects-root mount target the
		// RunPlan re-roots into); /work is the DISTINCT --mount root, never the
		// default WORKDIR.
		expect(dockerfile).toMatch(/^WORKDIR\s+\/projects\s*$/m);
		expect(dockerfile).not.toMatch(/^WORKDIR\s+\/work\s*$/m);
	});

	it('stages the trust.json in ANON_PI_STAGE (not the mounted ~/.pi/agent)', () => {
		// Writing into the persistent-mount path would be shadowed; the image must
		// stage into the dir anon-pi promotes into a fresh home on first launch.
		expect(dockerfile).toMatch(/ANON_PI_STAGE=\/opt\/anon-pi-seed\/agent/);
		expect(dockerfile).toMatch(/\$ANON_PI_STAGE\/trust\.json/);
		expect(dockerfile).not.toMatch(/> \/root\/\.pi\/agent\//);
	});

	it('pre-trusts BOTH cwd roots (/projects and /work) so pi never prompts', () => {
		const trust = extractTrustJson(dockerfile);
		expect(trust['/projects']).toBe(true);
		expect(trust['/work']).toBe(true);
	});
});

/**
 * Parse the object written by the `printf '{...}\n' > "$ANON_PI_STAGE/trust.json"`
 * line as JSON, so the assertions read the actual trusted-paths map rather than
 * matching a brittle substring.
 */
function extractTrustJson(text: string): Record<string, boolean> {
	const line = text
		.split('\n')
		.find((l) => l.includes('trust.json') && l.includes('printf'));
	expect(line, 'no printf ... > trust.json line').toBeTruthy();
	const m = /printf\s+'([^']*)'/.exec(line as string);
	expect(m, 'no single-quoted printf payload for trust.json').toBeTruthy();
	const payload = (m as RegExpExecArray)[1].replace(/\\n$/, '');
	return JSON.parse(payload) as Record<string, boolean>;
}
