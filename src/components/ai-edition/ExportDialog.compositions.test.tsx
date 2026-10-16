// @vitest-environment jsdom

// The export dialog opened for compositions: one presets the controls, lays its look over
// the document and names the file after it; several run as a batch — one picker, one file
// per composition beside the chosen one, each with its own frame and container.

import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/native", () => ({
	exportMultiNative: vi.fn(),
	exportGifNative: vi.fn(),
	cancelExportNative: vi.fn(async () => ({ accepted: true })),
	useIsCpuCompositor: () => false,
}));
vi.mock("@/native/sceneDescription", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/native/sceneDescription")>();
	return {
		...actual,
		buildSceneDescription: (doc: AxcutDocument) => ({
			speedRegions: [],
			// Enough of a scene for the test to read the frame the run was built for.
			aspect: getEditorSettings(doc).aspectRatio,
		}),
		resolveVisibleClips: (doc: AxcutDocument) => doc.timeline.clips,
	};
});

import { I18nProvider } from "@/contexts/I18nContext";
import { compositionFromPreset } from "@/lib/ai-edition/compositions/presets";
import { type AxcutDocument, axcutSchemaVersion } from "@/lib/ai-edition/schema";
import { getEditorSettings } from "@/lib/ai-edition/store/editorSettings";
import { exportGifNative, exportMultiNative } from "@/native";
import { ExportDialog } from "./ExportDialog";

const DOC: AxcutDocument = {
	schemaVersion: axcutSchemaVersion,
	project: {
		id: "proj_1",
		title: "Billing tour",
		createdAt: "2026-06-26T10:00:00Z",
		updatedAt: "2026-06-26T10:00:00Z",
		primaryAssetId: "a1",
	},
	assets: [
		{
			id: "a1",
			kind: "video",
			label: "asset",
			originalPath: "/tmp/a.mp4",
			cameraTrack: null,
			video: { codec: "h264", width: 1920, height: 1080, fps: 30 },
		},
	],
	transcript: null,
	transcripts: [],
	timeline: {
		clips: [
			{
				id: "c1",
				assetId: "a1",
				sourceStartSec: 0,
				sourceEndSec: 10,
				timelineStartSec: 0,
				timelineEndSec: 10,
				wordRefs: [],
				origin: "user",
				reason: "",
			},
		],
		gaps: [],
		trimRanges: [],
		muteRanges: [],
		speedRanges: [],
		captionRanges: [],
	},
	annotations: [],
	zoomRanges: [],
	audioTracks: [],
	legacyEditor: null,
};

let n = 0;
const ids = (prefix: string) => `${prefix}_${++n}`;
const picker = vi.fn(async () => ({ path: "/exports/billing-tour.mp4" }));

beforeEach(() => {
	vi.clearAllMocks();
	picker.mockResolvedValue({ path: "/exports/billing-tour.mp4" });
	vi.mocked(exportMultiNative).mockResolvedValue({
		frames: 600,
		wallS: 1,
		fps: 600,
		videoDurationS: 10,
		fileBytes: 4000,
	} as never);
	vi.mocked(exportGifNative).mockResolvedValue({
		frames: 150,
		wallS: 1,
		fps: 150,
		videoDurationS: 10,
		fileBytes: 4000,
	} as never);
	window.electronAPI = {
		pickExportSavePath: picker,
		onNativeExportProgress: vi.fn(() => () => undefined),
		dismissStarPrompt: vi.fn(async () => undefined),
		starPromptExportFinished: vi.fn(async () => ({ offer: false })),
	} as unknown as typeof window.electronAPI;
});

afterEach(() => {
	cleanup();
});

describe("the export dialog with compositions", () => {
	it("presets the controls from one composition, lays it over the document and names the file", async () => {
		const gif = compositionFromPreset("docs-gif", ids);
		render(
			<I18nProvider>
				<ExportDialog open onClose={vi.fn()} document={DOC} compositions={[gif]} />
			</I18nProvider>,
		);
		expect(screen.getByText("Export Docs GIF")).toBeInTheDocument();
		fireEvent.click(await screen.findByRole("button", { name: "Export GIF" }));
		await waitFor(() => expect(exportGifNative).toHaveBeenCalledOnce());
		expect(picker).toHaveBeenCalledWith("Billing_tour-docs-gif.gif");
		const [, outPath, sceneJson, params] = vi.mocked(exportGifNative).mock.calls[0];
		expect(outPath).toBe("/exports/billing-tour.mp4");
		expect(JSON.parse(sceneJson as string).aspect).toBe("16:9");
		expect(params).toMatchObject({ fps: 15, loopCount: 0 });
		expect(exportMultiNative).not.toHaveBeenCalled();
	});

	it("writes a batch beside the chosen file, one run per composition with its own frame", async () => {
		const youtube = compositionFromPreset("youtube", ids);
		const shorts = compositionFromPreset("shorts", ids);
		const gif = compositionFromPreset("docs-gif", ids);
		render(
			<I18nProvider>
				<ExportDialog open onClose={vi.fn()} document={DOC} compositions={[youtube, shorts, gif]} />
			</I18nProvider>,
		);
		expect(screen.getByText("Export 3 compositions")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Export MP4" }));
		await waitFor(() => expect(exportGifNative).toHaveBeenCalledOnce());
		expect(picker).toHaveBeenCalledTimes(1);
		expect(picker).toHaveBeenCalledWith("Billing_tour.mp4");
		expect(exportMultiNative).toHaveBeenCalledTimes(2);
		const mp4Calls = vi.mocked(exportMultiNative).mock.calls;
		expect(mp4Calls.map((call) => call[1])).toEqual([
			"/exports/billing-tour-youtube.mp4",
			"/exports/billing-tour-shorts-reels.mp4",
		]);
		expect(mp4Calls.map((call) => JSON.parse(call[2] as string).aspect)).toEqual(["16:9", "9:16"]);
		expect(mp4Calls.map((call) => (call[3] as { fps: number }).fps)).toEqual([60, 30]);
		expect(vi.mocked(exportGifNative).mock.calls[0][1]).toBe("/exports/billing-tour-docs-gif.gif");
		await waitFor(() => expect(screen.getByTestId("export-batch-done")).toBeInTheDocument());
		expect(screen.getByTestId("export-batch-done")).toHaveTextContent(
			"3 files written next to the first one.",
		);
	});
});
