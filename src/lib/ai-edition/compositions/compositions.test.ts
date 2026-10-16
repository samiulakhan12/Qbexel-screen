import { describe, expect, it } from "vitest";
import { getCaptionSettings } from "../captions/settings";
import {
	type AxcutComposition,
	type AxcutDocument,
	compositionSchema,
	createEmptyDocument,
	documentSchema,
} from "../schema";
import { getEditorSettings } from "../store/editorSettings";
import { documentForComposition, findComposition, resolveCompositionRef } from "./apply";
import {
	compositionFileName,
	compositionSlug,
	exportPlanFor,
	siblingExportPath,
} from "./exportPlan";
import {
	COMPOSITION_PRESET_ORDER,
	COMPOSITION_PRESETS,
	compositionFromPreset,
	customComposition,
} from "./presets";
import { captionInsideSafeArea, hasSafeArea, safeAreaInsetStyle, safeAreaOf } from "./safeArea";

let n = 0;
const ids = (prefix: string) => `${prefix}_${++n}`;

function doc(): AxcutDocument {
	const base = createEmptyDocument({ projectId: "p", title: "Billing tour" });
	return documentSchema.parse({
		...base,
		assets: [
			{
				id: "asset_1",
				kind: "video",
				label: "take",
				originalPath: "/tmp/take.mp4",
				durationSec: 30,
				video: { codec: "h264", width: 1920, height: 1080, fps: 30 },
				cameraTrack: null,
			},
		],
		timeline: {
			...base.timeline,
			clips: [
				{
					id: "clip_1",
					assetId: "asset_1",
					sourceStartSec: 0,
					sourceEndSec: 30,
					timelineStartSec: 0,
					timelineEndSec: 30,
					wordRefs: [],
					origin: "user",
					reason: "",
				},
			],
		},
		zoomRanges: [
			{
				id: "zoom_1",
				startMs: 2000,
				endMs: 6000,
				clipId: "clip_1",
				sourceStartSec: 2,
				sourceEndSec: 6,
				depth: 3,
				focus: { cx: 0.5, cy: 0.5 },
			},
		],
	});
}

describe("presets", () => {
	it("every preset validates and gets its own id", () => {
		for (const preset of COMPOSITION_PRESET_ORDER) {
			const composition = compositionFromPreset(preset, ids);
			expect(() => compositionSchema.parse(composition)).not.toThrow();
			expect(composition.preset).toBe(preset);
			expect(composition.name).toBe(COMPOSITION_PRESETS[preset].name);
		}
		const a = compositionFromPreset("shorts", ids);
		const b = compositionFromPreset("shorts", ids);
		expect(a.id).not.toBe(b.id);
		// A copy, not a reference to the template.
		a.safeArea!.top = 99;
		expect(COMPOSITION_PRESETS.shorts.safeArea?.top).toBe(12);
	});

	it("a custom composition keeps the frame it was given", () => {
		const custom = customComposition("16:10", ids);
		expect(() => compositionSchema.parse(custom)).not.toThrow();
		expect(custom.aspectRatio).toBe("16:10");
		expect(custom.export.format).toBe("mp4");
	});
});

describe("documentForComposition", () => {
	it("overlays the frame, fill, padding and caption placement, and nothing else", () => {
		const document = doc();
		const shorts = compositionFromPreset("shorts", ids);
		const next = documentForComposition(document, shorts);
		const settings = getEditorSettings(next);
		expect(settings.aspectRatio).toBe("9:16");
		expect(settings.formatFollowCursor).toBe(true);
		expect(settings.padding).toBe(0);
		const captions = getCaptionSettings(next, 9 / 16);
		expect(captions.anchorV).toBe("bottom");
		expect(captions.insetY).toBe(26);
		expect(captions.fontSize).toBe(60);
		// The edit is untouched.
		expect(next.timeline).toEqual(document.timeline);
		expect(next.zoomRanges).toEqual(document.zoomRanges);
		expect(next.annotations).toEqual(document.annotations);
		// And the source document was not mutated.
		expect(getEditorSettings(document).aspectRatio).not.toBe("9:16");
	});

	it("leaves settings a composition does not name as they were", () => {
		const document = doc();
		const before = getEditorSettings(document);
		const youtube = compositionFromPreset("youtube", ids);
		const settings = getEditorSettings(documentForComposition(document, youtube));
		expect(settings.aspectRatio).toBe("16:9");
		expect(settings.padding).toBe(before.padding);
		expect(settings.formatFollowCursor).toBe(before.formatFollowCursor);
	});

	it("finds compositions by id, and by name for the CLI", () => {
		const shorts = compositionFromPreset("shorts", ids);
		const square = compositionFromPreset("square", ids);
		const document: AxcutDocument = { ...doc(), compositions: [shorts, square] };
		expect(findComposition(document, shorts.id)).toBe(shorts);
		expect(findComposition(document, "nope")).toBeNull();
		expect(findComposition(doc(), shorts.id)).toBeNull();
		expect(resolveCompositionRef(document, square.id)).toBe(square);
		expect(resolveCompositionRef(document, "shorts / reels")).toBe(shorts);
		expect(resolveCompositionRef(document, "Nothing")).toBeNull();
		const twins: AxcutDocument = {
			...document,
			compositions: [shorts, { ...square, name: "Shorts / Reels" }],
		};
		expect(resolveCompositionRef(twins, "shorts / reels")).toBeNull();
	});
});

describe("export plan", () => {
	it("maps a composition's export onto the exporter's options, defaulting what is not on a list", () => {
		const gif = compositionFromPreset("docs-gif", ids);
		expect(exportPlanFor(gif)).toEqual({
			format: "gif",
			quality: "medium",
			fps: 30,
			gifFrameRate: 15,
			gifSize: "small",
			gifLoop: true,
		});
		const odd: AxcutComposition = {
			...compositionFromPreset("youtube", ids),
			export: { format: "mp4", quality: "source", fps: 45, gifFrameRate: 17 },
		};
		expect(exportPlanFor(odd)).toMatchObject({ fps: 60, gifFrameRate: 15, gifSize: "medium" });
	});

	it("names the file after the composition", () => {
		const shorts = compositionFromPreset("shorts", ids);
		expect(compositionSlug("Shorts / Reels")).toBe("shorts-reels");
		expect(compositionSlug("   ")).toBe("composition");
		expect(compositionFileName("billing-tour.mp4", shorts)).toBe("billing-tour-shorts-reels.mp4");
		expect(compositionFileName("billing-tour", compositionFromPreset("docs-gif", ids))).toBe(
			"billing-tour-docs-gif.gif",
		);
		expect(siblingExportPath("/exports/billing-tour.mp4", shorts)).toBe(
			"/exports/billing-tour-shorts-reels.mp4",
		);
		expect(siblingExportPath("C:\\out\\tour.mp4", compositionFromPreset("docs-gif", ids))).toBe(
			"C:\\out\\tour-docs-gif.gif",
		);
	});
});

describe("safe areas", () => {
	it("reads a composition's margins, with none for a composition without them", () => {
		const shorts = compositionFromPreset("shorts", ids);
		expect(hasSafeArea(safeAreaOf(shorts))).toBe(true);
		expect(hasSafeArea(safeAreaOf(null))).toBe(false);
		expect(safeAreaInsetStyle(safeAreaOf(shorts))).toEqual({
			top: "12%",
			bottom: "24%",
			left: "6%",
			right: "10%",
		});
	});

	it("says whether the preset's captions clear its own margins", () => {
		for (const preset of COMPOSITION_PRESET_ORDER) {
			const composition = compositionFromPreset(preset, ids);
			const caption = composition.captions;
			if (!caption?.anchorV || caption.insetY === undefined) continue;
			expect(
				captionInsideSafeArea(safeAreaOf(composition), {
					anchorV: caption.anchorV,
					insetY: caption.insetY,
				}),
			).toBe(true);
		}
	});
});
