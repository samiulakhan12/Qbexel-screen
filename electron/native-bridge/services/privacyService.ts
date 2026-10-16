// The Privacy Guardian over the bridge: scan a document, apply accepted findings, check
// an exported file, say what the machine can do. One scan at a time; a new scan or a
// cancel aborts the running one. Nothing here writes to disk or to a project: the
// renderer saves what comes back, like every other edit.

import { access, stat } from "node:fs/promises";
import path from "node:path";
import { documentSchema } from "../../../src/lib/ai-edition/schema";
import type {
	PrivacyApplyResult,
	PrivacyFileScanResult,
	PrivacyScanResult,
	PrivacyStatus,
} from "../../../src/native/contracts";
import { applyPrivacyFindings } from "../../privacy/apply";
import { type OcrEngineOptions, ocrModelPresent } from "../../privacy/ocr";
import {
	type PrivacyScanProgress,
	scanDocumentForSensitiveContent,
	scanVideoFileForSensitiveContent,
} from "../../privacy/scan";

export interface PrivacyServiceOptions {
	/** Where OCR keeps its model; null when OCR is not available in this build. */
	ocr: () => OcrEngineOptions | null;
	/** The ffmpeg executable, as the app resolves it; null when the install has none. */
	ffmpegPath: () => string | null;
}

/** Containers the export writes, and so the only files the post-export check reads. */
const SCANNABLE_EXTENSIONS = new Set([".mp4", ".gif", ".mov", ".webm", ".mkv"]);
export const MIN_SAMPLE_EVERY_MS = 500;
export const MAX_SAMPLE_EVERY_MS = 60_000;

export class PrivacyService {
	private current: AbortController | null = null;

	constructor(private readonly options: PrivacyServiceOptions) {}

	async status(): Promise<PrivacyStatus> {
		const ocr = this.options.ocr();
		return {
			ocrAvailable: ocr !== null,
			modelPresent: ocr ? await ocrModelPresent(ocr) : false,
			ffmpegPresent: this.options.ffmpegPath() !== null,
		};
	}

	async scan(
		input: { document: unknown; sampleEveryMs?: number },
		onProgress?: (progress: PrivacyScanProgress) => void,
	): Promise<PrivacyScanResult> {
		const parsed = documentSchema.safeParse(input.document);
		if (!parsed.success) {
			return { success: false, error: "The document snapshot is not valid." };
		}
		this.current?.abort();
		const controller = new AbortController();
		this.current = controller;
		try {
			const scan = await scanDocumentForSensitiveContent(parsed.data, {
				sampleEveryMs: input.sampleEveryMs,
				signal: controller.signal,
				onProgress,
				ocr: this.options.ocr(),
				ffmpegPath: this.options.ffmpegPath(),
			});
			return { success: true, scan, cancelled: controller.signal.aborted };
		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error.message : String(error),
			};
		} finally {
			if (this.current === controller) this.current = null;
		}
	}

	cancelScan(): { cancelled: boolean } {
		if (!this.current) return { cancelled: false };
		this.current.abort();
		return { cancelled: true };
	}

	apply(input: { document: unknown; findingIds: string[] }): PrivacyApplyResult {
		const parsed = documentSchema.safeParse(input.document);
		if (!parsed.success) {
			return {
				success: false,
				applied: [],
				failed: [],
				skipped: [],
				error: "The document snapshot is not valid.",
			};
		}
		try {
			return { success: true, ...applyPrivacyFindings(parsed.data, input.findingIds) };
		} catch (error) {
			return {
				success: false,
				applied: [],
				failed: [],
				skipped: [],
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	async scanFile(input: { path: string; durationSec?: number }): Promise<PrivacyFileScanResult> {
		const filePath = input.path;
		const refuse = (error: string): PrivacyFileScanResult => ({
			success: false,
			framesScanned: 0,
			findings: [],
			warnings: [],
			error,
		});
		if (typeof filePath !== "string" || !path.isAbsolute(filePath)) {
			return refuse("The file path must be absolute.");
		}
		if (!SCANNABLE_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
			return refuse("Only an exported video (.mp4, .gif, .mov, .webm, .mkv) can be checked.");
		}
		try {
			await access(filePath);
			if (!(await stat(filePath)).isFile()) return refuse("The path is not a file.");
		} catch {
			return refuse("The file could not be read.");
		}
		this.current?.abort();
		const controller = new AbortController();
		this.current = controller;
		try {
			const result = await scanVideoFileForSensitiveContent(filePath, {
				durationSec: input.durationSec,
				signal: controller.signal,
				ocr: this.options.ocr(),
				ffmpegPath: this.options.ffmpegPath(),
			});
			return {
				success: true,
				framesScanned: result.framesScanned,
				findings: result.findings.map((finding) => ({
					kind: finding.kind,
					preview: finding.preview,
					confidence: finding.confidence,
					timesMs: finding.boxes.map((box) => box.timeMs),
				})),
				warnings: result.warnings,
			};
		} catch (error) {
			return refuse(error instanceof Error ? error.message : String(error));
		} finally {
			if (this.current === controller) this.current = null;
		}
	}
}
