// Sampling frames of a recording for the Privacy Guardian.
//
// One ffmpeg run per recording writes a PNG every `everyMs` into a temporary folder,
// scaled down to `width` (OCR needs legible glyphs, not full resolution). Bounded on
// purpose: at most `maxFrames` frames, so a long recording is sampled more sparsely
// rather than scanned for minutes; and a wall-clock timeout, after which ffmpeg is
// killed and what was written so far is returned with a warning.
//
// Nothing here knows about documents or findings: it takes a file and gives back
// `{timeMs, path}` pairs, and the caller deletes the folder when it is done.

import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export interface SampledFrame {
	/** SOURCE ms of the recording. */
	timeMs: number;
	path: string;
}

export interface SampleFramesOptions {
	/** Interval between samples. */
	everyMs: number;
	/** The frame's width in pixels; height follows the aspect. */
	width?: number;
	/** Hard cap on frames written. */
	maxFrames?: number;
	timeoutMs?: number;
	signal?: AbortSignal;
	/** The ffmpeg executable, resolved by the caller as the app does (`resolveFfmpeg`); null
	 *  when the install has none, which the result then says. Kept out of this module so the
	 *  privacy code carries no Electron import and the CLI's tests can run it. */
	ffmpegPath: string | null;
}

export interface SampleFramesResult {
	frames: SampledFrame[];
	/** The folder the frames are in; the caller removes it with `removeFrames`. */
	dir: string;
	warnings: string[];
}

export const DEFAULT_SAMPLE_WIDTH = 1280;
export const DEFAULT_MAX_FRAMES = 120;
export const DEFAULT_SAMPLE_TIMEOUT_MS = 120_000;
/** Never sample more often than this: OCR time is per frame. */
export const MIN_SAMPLE_EVERY_MS = 500;

/** The sampling interval that keeps a recording of `durationSec` within `maxFrames`. */
export function sampleIntervalMs(
	durationSec: number,
	wantedEveryMs: number,
	maxFrames = DEFAULT_MAX_FRAMES,
): number {
	const minimum = Math.max(MIN_SAMPLE_EVERY_MS, wantedEveryMs);
	if (durationSec <= 0) return minimum;
	const needed = Math.ceil((durationSec * 1000) / maxFrames);
	return Math.max(minimum, needed);
}

export async function removeFrames(dir: string): Promise<void> {
	await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

export async function sampleFrames(
	filePath: string,
	options: SampleFramesOptions,
): Promise<SampleFramesResult> {
	const ffmpeg = options.ffmpegPath;
	const dir = await mkdtemp(path.join(tmpdir(), "qbexel-privacy-"));
	if (!ffmpeg) {
		return {
			frames: [],
			dir,
			warnings: ["ffmpeg is missing, so no frame could be read; only the transcript was scanned."],
		};
	}
	const everyMs = Math.max(MIN_SAMPLE_EVERY_MS, options.everyMs);
	const maxFrames = options.maxFrames ?? DEFAULT_MAX_FRAMES;
	const width = options.width ?? DEFAULT_SAMPLE_WIDTH;
	const warnings: string[] = [];

	await new Promise<void>((resolve) => {
		const child = spawn(
			ffmpeg,
			[
				"-hide_banner",
				"-loglevel",
				"error",
				"-i",
				filePath,
				"-vf",
				// `fps=1/N` emits the frame nearest each multiple of N seconds, the first at 0.
				`fps=1/${(everyMs / 1000).toFixed(3)},scale=${width}:-2`,
				"-frames:v",
				String(maxFrames),
				"-f",
				"image2",
				path.join(dir, "frame_%05d.png"),
			],
			{ stdio: ["ignore", "ignore", "pipe"] },
		);
		let stderr = "";
		let settled = false;
		const finish = (warning?: string) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			if (warning) warnings.push(warning);
			resolve();
		};
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish(
				`Reading frames took longer than ${Math.round((options.timeoutMs ?? DEFAULT_SAMPLE_TIMEOUT_MS) / 1000)} s; the recording was scanned up to where it stopped.`,
			);
		}, options.timeoutMs ?? DEFAULT_SAMPLE_TIMEOUT_MS);
		const onAbort = () => {
			child.kill("SIGKILL");
			finish("The scan was cancelled while reading frames.");
		};
		if (options.signal?.aborted) onAbort();
		else options.signal?.addEventListener("abort", onAbort, { once: true });
		child.stderr?.on("data", (chunk: Buffer) => {
			if (stderr.length < 4000) stderr += chunk.toString();
		});
		child.on("error", (error) => finish(`ffmpeg could not run: ${error.message}`));
		child.on("close", (code) => {
			finish(code === 0 ? undefined : `ffmpeg exited with ${code}: ${stderr.trim().slice(0, 300)}`);
		});
	});

	const names = (await readdir(dir).catch(() => [] as string[]))
		.filter((name) => /^frame_\d{5}\.png$/.test(name))
		.sort();
	const frames = names.map((name, index) => ({
		timeMs: index * everyMs,
		path: path.join(dir, name),
	}));
	return { frames, dir, warnings };
}
