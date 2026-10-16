// @vitest-environment jsdom

// The privacy gate in the export dialog: undecided findings stop the first click and
// offer "Export anyway" and "Review findings"; a reviewed or clean project exports
// straight away; the post-export check, when asked for, reads the finished file.

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
vi.mock("@/native/sceneDescription", () => ({
	buildSceneDescription: () => ({ speedRegions: [] }),
	resolveVisibleClips: (doc: AxcutDocument) => doc.timeline.clips,
}));
const bridge = vi.hoisted(() => ({ privacy: { scanFile: vi.fn() } }));
vi.mock("@/native/client", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/native/client")>();
	return { ...actual, nativeBridgeClient: bridge };
});

import { I18nProvider } from "@/contexts/I18nContext";
import {
	type AxcutDocument,
	type AxcutPrivacyReview,
	axcutSchemaVersion,
} from "@/lib/ai-edition/schema";
import { exportMultiNative } from "@/native";
import { ExportDialog } from "./ExportDialog";

const DOC: AxcutDocument = {
	schemaVersion: axcutSchemaVersion,
	project: {
		id: "proj_1",
		title: "Gate test",
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

function review(status: "suggested" | "dismissed"): AxcutPrivacyReview {
	return {
		version: 1,
		scan: {
			id: "scan_1",
			at: "2026-10-16T00:00:00.000Z",
			strategies: ["ocr"],
			ocrAvailable: true,
			sampleEveryMs: 2000,
			framesScanned: 5,
			assetIds: ["a1"],
			findings: [
				{
					id: "pf_1",
					kind: "email",
					preview: "j••••••e@example.com",
					confidence: 0.86,
					source: "frame",
					assetId: "a1",
					boxes: [{ timeMs: 1000, x: 0.1, y: 0.1, w: 0.2, h: 0.05 }],
					status,
					annotationIds: [],
				},
			],
			warnings: [],
		},
		reviewedAt: null,
		reviewedClipSignature: null,
	};
}

let onOpenPrivacy: ReturnType<typeof vi.fn<() => void>>;

function show(document: AxcutDocument) {
	render(
		<I18nProvider>
			<ExportDialog open onClose={vi.fn()} document={document} onOpenPrivacy={onOpenPrivacy} />
		</I18nProvider>,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	onOpenPrivacy = vi.fn<() => void>();
	bridge.privacy.scanFile.mockReset();
	vi.mocked(exportMultiNative).mockResolvedValue({
		frames: 600,
		wallS: 1,
		fps: 600,
		videoDurationS: 10,
		fileBytes: 4000,
	} as never);
	window.electronAPI = {
		pickExportSavePath: vi.fn(async () => ({ path: "/tmp/result.mp4" })),
		onNativeExportProgress: vi.fn(() => () => undefined),
		dismissStarPrompt: vi.fn(async () => undefined),
	} as unknown as typeof window.electronAPI;
});

afterEach(() => {
	cleanup();
});

describe("the export dialog's privacy gate", () => {
	it("stops the first click while findings are undecided, then exports on 'Export anyway'", async () => {
		show({ ...DOC, privacy: review("suggested") });
		expect(screen.getByText("1 privacy findings still need a decision.")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Export MP4" }));
		expect(window.electronAPI?.pickExportSavePath).not.toHaveBeenCalled();
		const anyway = await screen.findByTestId("export-privacy-anyway");
		fireEvent.click(screen.getByRole("button", { name: "Review findings" }));
		expect(onOpenPrivacy).toHaveBeenCalledTimes(1);
		fireEvent.click(anyway);
		await waitFor(() => expect(exportMultiNative).toHaveBeenCalledOnce());
	});

	it("exports straight away when the review is done, and says the project was never scanned", async () => {
		show({ ...DOC, privacy: review("dismissed") });
		expect(screen.getByText("Privacy review done.")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Export MP4" }));
		await waitFor(() => expect(exportMultiNative).toHaveBeenCalledOnce());
		expect(screen.queryByTestId("export-privacy-anyway")).not.toBeInTheDocument();
		cleanup();
		show(DOC);
		expect(screen.getByText("Not scanned for sensitive text.")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Export MP4" }));
		await waitFor(() => expect(exportMultiNative).toHaveBeenCalledTimes(2));
	});

	it("checks the exported file when asked and reports what it found", async () => {
		bridge.privacy.scanFile.mockResolvedValue({
			success: true,
			framesScanned: 5,
			findings: [
				{ kind: "email", preview: "j••••••e@example.com", confidence: 0.8, timesMs: [1000] },
			],
			warnings: [],
		});
		show({ ...DOC, privacy: review("dismissed") });
		fireEvent.click(
			screen.getByRole("button", { name: "Check the exported video for sensitive text" }),
		);
		fireEvent.click(screen.getByRole("button", { name: "Export MP4" }));
		await waitFor(() =>
			expect(bridge.privacy.scanFile).toHaveBeenCalledWith("/tmp/result.mp4", 10),
		);
		await waitFor(() =>
			expect(screen.getByTestId("export-privacy-check")).toHaveTextContent(
				/1 sensitive-looking items still show in the export: email j••••••e@example.com/,
			),
		);
	});
});
