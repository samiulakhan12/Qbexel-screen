// The Privacy Guardian's scan: every recording on the timeline, sampled and OCR'd,
// plus the transcript, into one `AxcutPrivacyScan`.
//
// The sampler and the OCR engine are injected, so the orchestration is tested without
// ffmpeg or a worker, and `electron/privacy/privacy.e2e.test.ts` runs the real ones on a
// synthetic recording when the machine has them. Partial results are results: a missing
// ffmpeg, a frame that fails, a cancelled run all leave what was found so far, with a
// warning saying what was skipped.

import { createId as defaultCreateId } from "../../src/lib/ai-edition/document/ids";
import {
	carryOverDecisions,
	type FrameFinding,
	frameFindings,
	mergeFrameFindings,
	transcriptFindings,
} from "../../src/lib/ai-edition/privacy/findings";
import { scannableAssetIds } from "../../src/lib/ai-edition/privacy/review";
import type {
	AxcutDocument,
	AxcutPrivacyFinding,
	AxcutPrivacyScan,
} from "../../src/lib/ai-edition/schema";
import {
	removeFrames,
	type SampleFramesOptions,
	type SampleFramesResult,
	sampleFrames,
	sampleIntervalMs,
} from "./frames";
import { createOcrEngine, type OcrEngine, type OcrEngineOptions } from "./ocr";

export interface PrivacyScanProgress {
	/** Frames OCR'd so far, over the frames sampled, across all recordings. */
	done: number;
	total: number;
	assetId: string;
}

export interface PrivacyScanOptions {
	/** Wanted interval between samples; widened to stay within the frame cap. */
	sampleEveryMs?: number;
	signal?: AbortSignal;
	onProgress?: (progress: PrivacyScanProgress) => void;
	/** Where the OCR engine keeps its language data. Absent → no OCR, transcript only. */
	ocr?: OcrEngineOptions | null;
	now?: () => Date;
	createId?: (prefix: string) => string;
	/** Test seams. */
	sampler?: (filePath: string, options: SampleFramesOptions) => Promise<SampleFramesResult>;
	engineFactory?: (options: OcrEngineOptions) => Promise<OcrEngine>;
	/** Per-asset duration, when the document's probe is missing; defaults to the asset's. */
	durationSecOf?: (assetId: string) => number | undefined;
}

export const DEFAULT_PRIVACY_SAMPLE_MS = 2000;

/** OCR one asset's sampled frames into findings; a failing frame is skipped with a warning. */
async function scanAssetFrames(
	assetId: string,
	frames: SampleFramesResult["frames"],
	engine: OcrEngine,
	options: PrivacyScanOptions,
	progress: { done: number; total: number },
	warnings: string[],
): Promise<FrameFinding[]> {
	const found: FrameFinding[] = [];
	let failed = 0;
	for (const frame of frames) {
		if (options.signal?.aborted) {
			warnings.push("The scan was cancelled; later frames were not read.");
			break;
		}
		try {
			found.push(...frameFindings(await engine.recognize(frame.path, frame.timeMs)));
		} catch {
			failed += 1;
		}
		progress.done += 1;
		options.onProgress?.({ done: progress.done, total: progress.total, assetId });
	}
	if (failed > 0) warnings.push(`${failed} frame(s) could not be read by the OCR engine.`);
	return found;
}

export async function scanDocumentForSensitiveContent(
	document: AxcutDocument,
	options: PrivacyScanOptions = {},
): Promise<AxcutPrivacyScan> {
	const createId = options.createId ?? defaultCreateId;
	const now = options.now ?? (() => new Date());
	const sampler = options.sampler ?? sampleFrames;
	const warnings: string[] = [];
	const findings: AxcutPrivacyFinding[] = [];
	const assetIds = scannableAssetIds(document);
	let framesScanned = 0;
	let ocrAvailable = false;
	let sampleEveryMs = Math.max(500, options.sampleEveryMs ?? DEFAULT_PRIVACY_SAMPLE_MS);

	// Transcript first: cheap, and it stands even when frames cannot be read.
	for (const transcript of document.transcripts) {
		if (!assetIds.includes(transcript.assetId)) continue;
		findings.push(...transcriptFindings(transcript, createId));
	}

	if (options.ocr) {
		let engine: OcrEngine | null = null;
		try {
			engine = await (options.engineFactory ?? createOcrEngine)(options.ocr);
			ocrAvailable = true;
		} catch (error) {
			warnings.push(
				`The OCR engine could not start (${error instanceof Error ? error.message : String(error)}); only the transcript was scanned.`,
			);
		}
		if (engine) {
			try {
				// Sample every recording first so the progress total is known before OCR starts.
				const sampled: Array<{ assetId: string; result: SampleFramesResult }> = [];
				for (const assetId of assetIds) {
					if (options.signal?.aborted) break;
					const asset = document.assets.find((candidate) => candidate.id === assetId);
					if (!asset?.originalPath) continue;
					const durationSec = options.durationSecOf?.(assetId) ?? asset.durationSec ?? 0;
					const everyMs = sampleIntervalMs(durationSec, sampleEveryMs);
					sampleEveryMs = Math.max(sampleEveryMs, everyMs);
					const result = await sampler(asset.originalPath, {
						everyMs,
						signal: options.signal,
					});
					warnings.push(...result.warnings);
					sampled.push({ assetId, result });
				}
				const progress = {
					done: 0,
					total: sampled.reduce((sum, entry) => sum + entry.result.frames.length, 0),
				};
				try {
					for (const { assetId, result } of sampled) {
						const frameFound = await scanAssetFrames(
							assetId,
							result.frames,
							engine,
							options,
							progress,
							warnings,
						);
						framesScanned += result.frames.length;
						findings.push(...mergeFrameFindings(frameFound, assetId, createId));
						if (options.signal?.aborted) break;
					}
				} finally {
					await Promise.all(sampled.map((entry) => removeFrames(entry.result.dir)));
				}
			} finally {
				await engine.terminate();
			}
		}
	} else {
		warnings.push("Frames were not read: OCR is not set up. Only the transcript was scanned.");
	}

	return {
		id: createId("scan"),
		at: now().toISOString(),
		strategies: ocrAvailable ? ["transcript", "ocr"] : ["transcript"],
		ocrAvailable,
		sampleEveryMs,
		framesScanned,
		assetIds,
		findings: carryOverDecisions(document.privacy?.scan, findings, document),
		warnings: [...new Set(warnings)],
	};
}

export interface FileScanResult {
	framesScanned: number;
	findings: AxcutPrivacyFinding[];
	warnings: string[];
}

/**
 * The post-export check: sample and OCR one finished video file. Findings carry the
 * file as their "asset", for the report only; nothing is written anywhere.
 */
export async function scanVideoFileForSensitiveContent(
	filePath: string,
	options: PrivacyScanOptions & { durationSec?: number } = {},
): Promise<FileScanResult> {
	const createId = options.createId ?? defaultCreateId;
	const sampler = options.sampler ?? sampleFrames;
	const warnings: string[] = [];
	if (!options.ocr) {
		return { framesScanned: 0, findings: [], warnings: ["OCR is not set up."] };
	}
	let engine: OcrEngine;
	try {
		engine = await (options.engineFactory ?? createOcrEngine)(options.ocr);
	} catch (error) {
		return {
			framesScanned: 0,
			findings: [],
			warnings: [
				`The OCR engine could not start (${error instanceof Error ? error.message : String(error)}).`,
			],
		};
	}
	try {
		const everyMs = sampleIntervalMs(
			options.durationSec ?? 0,
			Math.max(500, options.sampleEveryMs ?? DEFAULT_PRIVACY_SAMPLE_MS),
		);
		const result = await sampler(filePath, { everyMs, signal: options.signal });
		warnings.push(...result.warnings);
		try {
			const progress = { done: 0, total: result.frames.length };
			const found = await scanAssetFrames(
				filePath,
				result.frames,
				engine,
				options,
				progress,
				warnings,
			);
			return {
				framesScanned: result.frames.length,
				findings: mergeFrameFindings(found, filePath, createId),
				warnings: [...new Set(warnings)],
			};
		} finally {
			await removeFrames(result.dir);
		}
	} finally {
		await engine.terminate();
	}
}
