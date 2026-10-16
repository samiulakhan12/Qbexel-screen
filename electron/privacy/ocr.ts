// Reading text off sampled frames with tesseract.js, in the main process.
//
// Tesseract runs locally (WebAssembly in a Node worker thread); no frame ever leaves
// the machine. Its language model (`eng.traineddata`, ~5 MB) is looked for in the app's
// resources first and otherwise fetched once into the user-data cache — a download of a
// public model, never an upload — and the UI says so before the first scan.
//
// One worker per scan, reused across frames, terminated at the end. The module keeps
// no global state, so a cancelled scan cannot leave a worker behind.

import { access } from "node:fs/promises";
import path from "node:path";
import type { OcrFrame, OcrLine } from "../../src/lib/ai-edition/privacy/findings";

export interface OcrEngine {
	recognize(imagePath: string, timeMs: number): Promise<OcrFrame>;
	terminate(): Promise<void>;
}

export interface OcrEngineOptions {
	/** Where the language data is cached (downloaded on first use when absent). */
	cachePath: string;
	/** A folder shipping `eng.traineddata(.gz)`, used instead of any download when present. */
	bundledLangDir?: string | null;
	language?: string;
}

/** Tesseract's `recognize` output, the parts this module reads. */
interface TesseractBlockData {
	text: string;
	blocks?: Array<{
		paragraphs: Array<{
			lines: Array<{
				words: Array<{
					text: string;
					confidence: number;
					bbox: { x0: number; y0: number; x1: number; y1: number };
				}>;
			}>;
		}>;
	}> | null;
}

interface TesseractWorkerLike {
	recognize(
		image: string,
		options: Record<string, unknown>,
		output: Record<string, unknown>,
	): Promise<{ data: TesseractBlockData }>;
	terminate(): Promise<unknown>;
}

async function exists(filePath: string): Promise<boolean> {
	try {
		await access(filePath);
		return true;
	} catch {
		return false;
	}
}

/** Whether the language data is already on this machine (no download needed). */
export async function ocrModelPresent(options: OcrEngineOptions): Promise<boolean> {
	const language = options.language ?? "eng";
	const candidates = [
		options.bundledLangDir ? path.join(options.bundledLangDir, `${language}.traineddata`) : null,
		options.bundledLangDir ? path.join(options.bundledLangDir, `${language}.traineddata.gz`) : null,
		path.join(options.cachePath, `${language}.traineddata`),
	].filter((candidate): candidate is string => candidate !== null);
	for (const candidate of candidates) if (await exists(candidate)) return true;
	return false;
}

/** The PNG's pixel size, read from its header: Tesseract reports boxes in pixels. */
export async function pngSize(filePath: string): Promise<{ width: number; height: number }> {
	const { open } = await import("node:fs/promises");
	const handle = await open(filePath, "r");
	try {
		const header = Buffer.alloc(24);
		await handle.read(header, 0, 24, 0);
		if (header.toString("ascii", 1, 4) !== "PNG") throw new Error(`${filePath} is not a PNG`);
		return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
	} finally {
		await handle.close();
	}
}

export function linesFromBlocks(data: TesseractBlockData): OcrLine[] {
	const lines: OcrLine[] = [];
	for (const block of data.blocks ?? []) {
		for (const paragraph of block.paragraphs) {
			for (const line of paragraph.lines) {
				lines.push({
					words: line.words.map((word) => ({
						text: word.text,
						confidence: word.confidence,
						bbox: word.bbox,
					})),
				});
			}
		}
	}
	return lines;
}

export async function createOcrEngine(options: OcrEngineOptions): Promise<OcrEngine> {
	const language = options.language ?? "eng";
	// Loaded here, not at module top: the renderer-side tests import the privacy pane
	// without ever needing a worker, and the package spawns threads on load paths.
	const tesseract = (await import("tesseract.js")) as unknown as {
		createWorker: (
			lang: string,
			oem: number,
			options: Record<string, unknown>,
		) => Promise<TesseractWorkerLike>;
	};
	const useBundled =
		options.bundledLangDir &&
		((await exists(path.join(options.bundledLangDir, `${language}.traineddata`))) ||
			(await exists(path.join(options.bundledLangDir, `${language}.traineddata.gz`))));
	const worker = await tesseract.createWorker(language, 1, {
		cachePath: options.cachePath,
		...(useBundled ? { langPath: options.bundledLangDir, gzip: false } : {}),
		logger: () => undefined,
		errorHandler: () => undefined,
	});
	return {
		async recognize(imagePath, timeMs) {
			const [{ data }, size] = await Promise.all([
				worker.recognize(imagePath, {}, { blocks: true, text: true }),
				pngSize(imagePath),
			]);
			return { timeMs, width: size.width, height: size.height, lines: linesFromBlocks(data) };
		},
		async terminate() {
			await worker.terminate().catch(() => undefined);
		},
	};
}
