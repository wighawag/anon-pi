import {describe, it, expect} from 'vitest';
import {
	ANON_ACCOUNT,
	HARDENED_HOME_MODE,
	buildTier2ProvisioningScript,
	tier2NeedsFromFailures,
	evaluateHardenedPreflight,
	planHardeningStep,
	type HardenedPreflightProbes,
	type HardenedPreflightResult,
	type HardeningStepInputs,
} from '../src/index.js';

// The PURE resumable hardening-step ORCHESTRATOR (docs/adr/0006, prd
// `hardened-dedicated-account-deployment` stories 1 + 5-8). `planHardeningStep`
// stitches the three pure pieces (preflight, Tier-2 script, Tier-1 plan) into
// the ONE next action of the resumable `init` step, over an INJECTED preflight
// RESULT. cli.ts does the real probing/printing/waiting and the mode-700 write;
// NOTHING here spawns, probes, sudo's, or touches the fs. The two seams the task
// calls out: missing-account -> print-script-and-wait; passing -> continue.

/** All-pass probe inputs (a fully-provisioned `anon` account + a system anon-pi). */
const allPassProbes: HardenedPreflightProbes = {
	anonPiResolvedPath: '/usr/local/bin/anon-pi',
	loginHome: '/home/operator',
	subidRangesPresent: true,
	lingerEnabled: true,
	tunAccessible: true,
	xdgRuntimeDirPresent: true,
	netcageVersion: 'netcage 0.11.0',
};

/** A missing/half-provisioned account (no subuid ranges, no linger, ...). */
const missingAccountProbes: HardenedPreflightProbes = {
	anonPiResolvedPath: '/usr/local/bin/anon-pi',
	loginHome: '/home/operator',
	subidRangesPresent: false,
	lingerEnabled: false,
	tunAccessible: true,
	xdgRuntimeDirPresent: false,
	netcageVersion: 'netcage 0.11.0',
};

function inputs(
	preflight: HardenedPreflightResult,
	over: Partial<HardeningStepInputs> = {},
): HardeningStepInputs {
	return {
		preflight,
		account: ANON_ACCOUNT,
		loginUser: 'operator',
		anonPiPath: '/usr/local/bin/anon-pi',
		loginHome: '/home/operator',
		anonHome: '/home/anon/.anon-pi',
		...over,
	};
}

describe('planHardeningStep: preflight PASSES -> continue Tier 1', () => {
	it('returns a continue-tier1 plan pointing ANON_PI_HOME into the account tree, mode 0o700', () => {
		const preflight = evaluateHardenedPreflight(allPassProbes);
		expect(preflight.ok).toBe(true);
		const plan = planHardeningStep(inputs(preflight));
		expect(plan.kind).toBe('continue-tier1');
		if (plan.kind !== 'continue-tier1') throw new Error('wrong kind');
		expect(plan.anonHome).toBe('/home/anon/.anon-pi');
		expect(plan.mode).toBe(HARDENED_HOME_MODE);
		expect(plan.mode).toBe(0o700);
	});

	it('produces NO wrapper file and never references NETCAGE_GRAPHROOT', () => {
		const preflight = evaluateHardenedPreflight(allPassProbes);
		const plan = planHardeningStep(inputs(preflight));
		// The plan is Tier-1 only (workspace path + mode); there is no wrapper
		// field and no graphroot anywhere in the serialised plan.
		expect(JSON.stringify(plan)).not.toContain('wrapper');
		expect(JSON.stringify(plan)).not.toContain('NETCAGE_GRAPHROOT');
	});
});

describe('planHardeningStep: account missing/half-provisioned -> print-and-wait', () => {
	it('returns a wait-for-account plan carrying the Tier-2 script + a run-then-continue instruction', () => {
		const preflight = evaluateHardenedPreflight(missingAccountProbes);
		expect(preflight.ok).toBe(false);
		const plan = planHardeningStep(inputs(preflight));
		expect(plan.kind).toBe('wait-for-account');
		if (plan.kind !== 'wait-for-account') throw new Error('wrong kind');
		// the script is EXACTLY what the Tier-2 generator emits for these inputs.
		expect(plan.script).toBe(
			buildTier2ProvisioningScript({
				account: ANON_ACCOUNT,
				loginUser: 'operator',
				anonPiPath: '/usr/local/bin/anon-pi',
				loginHome: '/home/operator',
				needs: tier2NeedsFromFailures(preflight.failures.map((f) => f.id)),
			}),
		);
		// the instruction tells the human to run it with sudo elsewhere and continue.
		expect(plan.instruction.toLowerCase()).toContain('sudo');
		expect(plan.instruction.toLowerCase()).toContain('continue');
		// and it echoes the exact preflight failures (what is missing).
		expect(plan.failures).toEqual(preflight.failures);
		expect(plan.failures.map((f) => f.id)).toContain('subid');
	});

	it('forwards the --nopasswd opt-in into the printed Tier-2 script', () => {
		const preflight = evaluateHardenedPreflight(missingAccountProbes);
		const plan = planHardeningStep(inputs(preflight, {nopasswd: true}));
		if (plan.kind !== 'wait-for-account') throw new Error('wrong kind');
		expect(plan.script).toContain('NOPASSWD');
		// default (no flag) keeps the password.
		const kept = planHardeningStep(inputs(preflight));
		if (kept.kind !== 'wait-for-account') throw new Error('wrong kind');
		expect(kept.script).not.toContain('NOPASSWD');
	});

	it('never emits a NETCAGE_GRAPHROOT export in the printed script', () => {
		const preflight = evaluateHardenedPreflight(missingAccountProbes);
		const plan = planHardeningStep(inputs(preflight));
		if (plan.kind !== 'wait-for-account') throw new Error('wrong kind');
		expect(plan.script).not.toContain('NETCAGE_GRAPHROOT');
	});
});

describe('planHardeningStep: resumability is stateless (re-plan over a fresh preflight)', () => {
	it('a re-run whose account now exists FLIPS from wait to continue (no persisted flag)', () => {
		// first pass: account missing -> wait.
		const first = planHardeningStep(
			inputs(evaluateHardenedPreflight(missingAccountProbes)),
		);
		expect(first.kind).toBe('wait-for-account');
		// human runs the script; the impure loop re-probes; now all-pass -> continue.
		const second = planHardeningStep(
			inputs(evaluateHardenedPreflight(allPassProbes)),
		);
		expect(second.kind).toBe('continue-tier1');
	});

	it('is deterministic (same preflight -> identical plan)', () => {
		const preflight = evaluateHardenedPreflight(missingAccountProbes);
		expect(planHardeningStep(inputs(preflight))).toEqual(
			planHardeningStep(inputs(preflight)),
		);
	});
});
