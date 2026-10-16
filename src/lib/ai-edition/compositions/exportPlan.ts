// What a composition asks the exporter for, in the exporter's own types, and the file it
// goes to. The composition stores plain numbers and strings (the schema does not know the
// exporter's lists); this is where they are checked against those lists and defaulted.

import {
	type ExportFormat,
	type ExportQuality,
	type GifFrameRate,
	type GifSizePreset,
	MP4_FRAME_RATES,
	type Mp4FrameRate,
} from "@/lib/exporter/types";
import type { AxcutComposition } from "../schema";

export interface CompositionExportPlan {
	format: ExportFormat;
	quality: ExportQuality;
	fps: Mp4FrameRate;
	gifFrameRate: GifFrameRate;
	gifSize: GifSizePreset;
	gifLoop: boolean;
}

const GIF_FRAME_RATES: readonly GifFrameRate[] = [15, 20, 25, 30];

export function exportPlanFor(composition: AxcutComposition): CompositionExportPlan {
	const wanted = composition.export;
	const fps = (MP4_FRAME_RATES as readonly number[]).includes(wanted.fps)
		? (wanted.fps as Mp4FrameRate)
		: 60;
	const gifFrameRate =
		wanted.gifFrameRate !== undefined &&
		GIF_FRAME_RATES.includes(wanted.gifFrameRate as GifFrameRate)
			? (wanted.gifFrameRate as GifFrameRate)
			: 15;
	return {
		format: wanted.format,
		quality: wanted.quality,
		fps,
		gifFrameRate,
		gifSize: wanted.gifSize ?? "medium",
		gifLoop: wanted.gifLoop ?? true,
	};
}

/** `my-video` + "Shorts / Reels" → `my-video-shorts-reels`; the extension follows the format. */
export function compositionSlug(name: string): string {
	return (
		name
			.toLowerCase()
			.normalize("NFKD")
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 40) || "composition"
	);
}

export function compositionFileName(baseName: string, composition: AxcutComposition): string {
	const stem = baseName.replace(/\.(mp4|gif)$/i, "");
	return `${stem}-${compositionSlug(composition.name)}.${composition.export.format === "gif" ? "gif" : "mp4"}`;
}

/** The file beside `pickedPath` that a composition of a batch goes to, named after it. */
export function siblingExportPath(pickedPath: string, composition: AxcutComposition): string {
	const cut = Math.max(pickedPath.lastIndexOf("/"), pickedPath.lastIndexOf("\\"));
	const dir = pickedPath.slice(0, cut + 1);
	const base = pickedPath.slice(cut + 1);
	return dir + compositionFileName(base, composition);
}
