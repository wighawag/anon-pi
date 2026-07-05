// The `-p --mode text-stream` WATCH surface: anon-pi owns the `text-stream` mode
// value, strips it, rewrites the forwarded pi args to `--mode json`, then renders
// pi's JSONL event stream as a readable per-turn view (dorfl granularity). Two
// PURE seams are proven here:
//   - extractWatchMode / piArgsForWatch (via parseLaunchArgs): the argv rewrite +
//     the refusals (no `-p`, a second `--mode`);
//   - formatWatchStreamLine: the JSONL-stream classifier (message_end only, text
//     + `▶ <tool>` lines, last-answer capture, defensive on junk).
import {describe, it, expect} from 'vitest';
import {
	AnonPiError,
	MODE_FLAG,
	WATCH_MODE_TOKEN,
	WATCH_PI_MODE,
	extractWatchMode,
	piArgsForWatch,
	parseLaunchArgs,
	formatWatchStreamLine,
} from '../src/index.js';

describe('extractWatchMode — the anon-pi-owned text-stream mode', () => {
	it('no `--mode text-stream` => watch:false, args unchanged', () => {
		const r = extractWatchMode(['-p', 'hello']);
		expect(r.watch).toBe(false);
		expect(r.piArgs).toEqual(['-p', 'hello']);
	});

	it('undefined args => watch:false, empty args', () => {
		const r = extractWatchMode(undefined);
		expect(r.watch).toBe(false);
		expect(r.piArgs).toEqual([]);
	});

	it('`-p --mode text-stream` => watch:true, the mode pair STRIPPED', () => {
		const r = extractWatchMode(['-p', MODE_FLAG, WATCH_MODE_TOKEN, 'hi']);
		expect(r.watch).toBe(true);
		expect(r.piArgs).toEqual(['-p', 'hi']);
	});

	it('leaves a NON-text-stream `--mode <x>` untouched (forwarded to pi)', () => {
		const r = extractWatchMode(['-p', MODE_FLAG, 'rpc']);
		expect(r.watch).toBe(false);
		expect(r.piArgs).toEqual(['-p', MODE_FLAG, 'rpc']);
	});

	it('REFUSES `--mode text-stream` without `-p`', () => {
		expect(() => extractWatchMode([MODE_FLAG, WATCH_MODE_TOKEN, 'hi'])).toThrow(
			AnonPiError,
		);
	});

	it('REFUSES `--mode text-stream` alongside a second `--mode`', () => {
		expect(() =>
			extractWatchMode(['-p', MODE_FLAG, WATCH_MODE_TOKEN, MODE_FLAG, 'json']),
		).toThrow(AnonPiError);
	});

	it('REFUSES a duplicated `--mode text-stream`', () => {
		expect(() =>
			extractWatchMode([
				'-p',
				MODE_FLAG,
				WATCH_MODE_TOKEN,
				MODE_FLAG,
				WATCH_MODE_TOKEN,
			]),
		).toThrow(AnonPiError);
	});
});

describe('piArgsForWatch — inject the real pi mode', () => {
	it('appends `--mode json` (the stream anon-pi parses)', () => {
		expect(piArgsForWatch(['-p', 'hi'])).toEqual([
			'-p',
			'hi',
			MODE_FLAG,
			WATCH_PI_MODE,
		]);
	});
});

describe('parseLaunchArgs — text-stream end-to-end (project + no-project)', () => {
	it('project path: `<p> -p --mode text-stream "q"` => watch + `--mode json` forwarded', () => {
		const p = parseLaunchArgs([
			'recon',
			'-p',
			MODE_FLAG,
			WATCH_MODE_TOKEN,
			'q',
		]);
		expect(p.mode).toBe('pi');
		expect(p.project).toBe('recon');
		expect(p.watch).toBe(true);
		expect(p.piArgs).toEqual(['-p', 'q', MODE_FLAG, WATCH_PI_MODE]);
	});

	it('no-project path: `-p --mode text-stream "q"` => watch + `--mode json` forwarded', () => {
		const p = parseLaunchArgs(['-p', MODE_FLAG, WATCH_MODE_TOKEN, 'q']);
		expect(p.mode).toBe('pi');
		expect(p.project).toBeUndefined();
		expect(p.watch).toBe(true);
		expect(p.piArgs).toEqual(['-p', 'q', MODE_FLAG, WATCH_PI_MODE]);
	});

	it('a plain launch keeps watch falsy and does not inject a mode', () => {
		const p = parseLaunchArgs(['recon', '-p', 'q']);
		expect(p.watch).toBeFalsy();
		expect(p.piArgs).toEqual(['-p', 'q']);
	});

	it('a bare interactive launch keeps piArgs undefined (no `[]` regression)', () => {
		const p = parseLaunchArgs(['recon']);
		expect(p.piArgs).toBeUndefined();
		expect(p.watch).toBeFalsy();
	});

	it('REFUSES `<p> --mode text-stream` without `-p` (interactive)', () => {
		expect(() =>
			parseLaunchArgs(['recon', MODE_FLAG, WATCH_MODE_TOKEN]),
		).toThrow(AnonPiError);
	});
});

describe('formatWatchStreamLine — the JSONL stream classifier', () => {
	const msgEnd = (content: unknown, role = 'assistant'): string =>
		JSON.stringify({type: 'message_end', message: {role, content}});

	it('an assistant message_end text part => one line + captured answer', () => {
		const r = formatWatchStreamLine(
			msgEnd([{type: 'text', text: 'Done.'}]),
			false,
		);
		expect(r.lines).toEqual(['Done.']);
		expect(r.answer).toBe('Done.');
	});

	it('a toolCall part => `▶ <name>` after the text', () => {
		const r = formatWatchStreamLine(
			msgEnd([
				{type: 'text', text: "I'll list the files."},
				{type: 'toolCall', id: 'x', name: 'ls', arguments: {}},
			]),
			false,
		);
		expect(r.lines).toEqual(["I'll list the files.", '▶ ls']);
		expect(r.answer).toBe("I'll list the files.");
	});

	it('falls back to `toolName` then `tool` for the marker', () => {
		expect(
			formatWatchStreamLine(
				msgEnd([{type: 'toolCall', toolName: 'grep'}]),
				false,
			).lines,
		).toEqual(['▶ grep']);
		expect(
			formatWatchStreamLine(msgEnd([{type: 'toolCall'}]), false).lines,
		).toEqual(['▶ tool']);
	});

	it('a tool-only turn surfaces the marker but captures NO answer', () => {
		const r = formatWatchStreamLine(
			msgEnd([{type: 'toolCall', name: 'ls'}]),
			false,
		);
		expect(r.lines).toEqual(['▶ ls']);
		expect(r.answer).toBeUndefined();
	});

	it('colour wraps the tool marker in ANSI when color=true', () => {
		const r = formatWatchStreamLine(
			msgEnd([{type: 'toolCall', name: 'ls'}]),
			true,
		);
		expect(r.lines[0]).toBe('\u001b[36m▶ ls\u001b[0m');
	});

	it('SKIPS deltas, lifecycle, user/toolResult messages, blanks, and junk', () => {
		const skipped = [
			'',
			'   ',
			'not json {',
			JSON.stringify({type: 'session', id: 'x'}),
			JSON.stringify({type: 'agent_start'}),
			JSON.stringify({type: 'message_update', assistantMessageEvent: {}}),
			JSON.stringify({type: 'agent_end', messages: []}),
			msgEnd([{type: 'text', text: 'you'}], 'user'),
			msgEnd([{type: 'text', text: 'result'}], 'toolResult'),
		];
		for (const line of skipped) {
			expect(formatWatchStreamLine(line, false)).toEqual({lines: []});
		}
	});

	it('a plain-string assistant content is itself the answer text', () => {
		const r = formatWatchStreamLine(msgEnd('hi there'), false);
		expect(r.lines).toEqual(['hi there']);
		expect(r.answer).toBe('hi there');
	});
});
