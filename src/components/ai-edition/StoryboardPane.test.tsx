// @vitest-environment jsdom

// The Storyboard pane against a mocked bridge: analysis lands on the document, review
// decisions are saved, approved suggestions go to `director.apply` and its document is
// what the store ends up holding. The analyser and the apply step have their own tests;
// this one is about the pane doing what its controls say.

import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import {
	type AxcutDocument,
	type AxcutStoryboard,
	createEmptyDocument,
	documentSchema,
} from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { StoryboardPane } from "./StoryboardPane";

const bridge = vi.hoisted(() => ({
	save: vi.fn(),
	directorAnalyze: vi.fn(),
	directorApply: vi.fn(),
}));
vi.mock("@/native", () => ({ nativeBridgeClient: { aiEdition: bridge } }));
vi.mock("@/native/client", () => ({ nativeBridgeClient: { aiEdition: bridge } }));
vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

function fixture(): AxcutDocument {
	const base = createEmptyDocument({ projectId: "p1", title: "Billing tour" });
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
		project: { ...base.project, primaryAssetId: "asset_1" },
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
	});
}

function storyboard(): AxcutStoryboard {
	return {
		version: 1,
		generatedAt: "2026-10-16T00:00:00.000Z",
		clipSignature: "whatever",
		enrichment: null,
		scenes: [
			{
				id: "scene_1",
				order: 0,
				title: "Open the billing tab",
				startMs: 0,
				endMs: 30000,
				clipId: "clip_1",
				narration: "Open the billing tab to see your plan",
				observed: [{ kind: "click", atMs: 2000, cx: 0.25, cy: 0.75 }],
				inferred: [
					{ kind: "title", text: "Open the billing tab", confidence: 0.5, source: "heuristic" },
				],
			},
		],
		suggestions: [
			{
				id: "sb_cut",
				sceneId: "scene_1",
				kind: "cut",
				status: "proposed",
				source: "heuristic",
				rationale: "2.4 s pause with no speech or click",
				appliedIds: [],
				reason: "silence",
				assetId: "asset_1",
				clipId: "clip_1",
				sourceStartSec: 5,
				sourceEndSec: 7,
			},
			{
				id: "sb_zoom",
				sceneId: "scene_1",
				kind: "zoom",
				status: "proposed",
				source: "heuristic",
				rationale: "Recorded clicks cluster here",
				appliedIds: [],
				startMs: 1500,
				endMs: 4000,
				focus: { cx: 0.25, cy: 0.75 },
				depth: 3,
			},
		],
	};
}

function show(document: AxcutDocument) {
	useProjectStore.setState({ document, projectId: "p1" });
	render(
		<I18nProvider>
			<StoryboardPane />
		</I18nProvider>,
	);
}

const stored = () => useProjectStore.getState().document as AxcutDocument;

beforeEach(() => {
	bridge.save.mockReset();
	bridge.directorAnalyze.mockReset();
	bridge.directorApply.mockReset();
	// The bridge echoes what it is asked to save, as the real one does on success.
	bridge.save.mockImplementation(async (document: unknown) => ({ success: true, document }));
});

afterEach(() => {
	cleanup();
	useProjectStore.getState().clear();
});

describe("StoryboardPane", () => {
	it("analyses the recording and shows observed facts apart from inferences", async () => {
		bridge.directorAnalyze.mockResolvedValue({
			success: true,
			enriched: false,
			storyboard: storyboard(),
		});
		show(fixture());
		expect(screen.queryByText("Open the billing tab")).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "Analyse recording" }));

		await waitFor(() => expect(stored().storyboard?.scenes).toHaveLength(1));
		expect(bridge.directorAnalyze).toHaveBeenCalledTimes(1);
		expect(bridge.directorAnalyze.mock.calls[0][1]).toMatchObject({ enrich: false });
		// The title heads the scene and is repeated as the heuristic inference it came from.
		expect(screen.getAllByText("Open the billing tab").length).toBeGreaterThanOrEqual(1);
		expect(screen.getByText("Observed")).toBeInTheDocument();
		expect(screen.getByText("Heuristic")).toBeInTheDocument();
		expect(screen.getByText("Click at 0:02.0")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Analyse again" })).toBeInTheDocument();
	});

	it("only asks the model when the consent toggle is on", async () => {
		bridge.directorAnalyze.mockResolvedValue({
			success: true,
			enriched: true,
			model: "gpt-test",
			storyboard: {
				...storyboard(),
				enrichment: { provider: "openai", model: "gpt-test", at: "2026-10-16T00:00:00.000Z" },
			},
		});
		show(fixture());
		fireEvent.click(screen.getByRole("button", { name: "Ask the AI model for scene titles" }));
		fireEvent.click(screen.getByRole("button", { name: "Analyse recording" }));
		await waitFor(() => expect(bridge.directorAnalyze).toHaveBeenCalledTimes(1));
		expect(bridge.directorAnalyze.mock.calls[0][1]).toMatchObject({ enrich: true });
		await waitFor(() => expect(screen.getByText(/Titles by gpt-test/)).toBeInTheDocument());
	});

	it("shows the model-pass warning while keeping the deterministic storyboard", async () => {
		bridge.directorAnalyze.mockResolvedValue({
			success: true,
			enriched: false,
			storyboard: storyboard(),
			warning: "No AI provider is configured.",
		});
		show(fixture());
		fireEvent.click(screen.getByRole("button", { name: "Analyse recording" }));
		await waitFor(() => expect(stored().storyboard).toBeTruthy());
		expect(screen.getByText(/No AI provider is configured\./)).toBeInTheDocument();
	});

	it("records approvals, applies them through the bridge and keeps its document", async () => {
		const doc: AxcutDocument = { ...fixture(), storyboard: storyboard() };
		show(doc);
		const applyApproved = screen.getByRole("button", { name: "Apply approved (0)" });
		expect(applyApproved).toBeDisabled();

		fireEvent.click(screen.getAllByRole("button", { name: "Approve" })[0]);
		await waitFor(() =>
			expect(stored().storyboard?.suggestions.map((s) => s.status)).toEqual([
				"approved",
				"proposed",
			]),
		);
		expect(screen.getByRole("button", { name: "Apply approved (1)" })).toBeEnabled();

		const applied: AxcutDocument = {
			...stored(),
			timeline: {
				...doc.timeline,
				trimRanges: [
					{
						id: "trim_new",
						assetId: "asset_1",
						clipId: "clip_1",
						startSec: 5,
						endSec: 7,
						reason: "Director: silence",
						origin: "agent",
					},
				],
			},
			storyboard: {
				...storyboard(),
				suggestions: storyboard().suggestions.map((s) =>
					s.id === "sb_cut" ? { ...s, status: "applied", appliedIds: ["trim_new"] } : s,
				),
			},
		};
		bridge.directorApply.mockResolvedValue({
			success: true,
			document: applied,
			applied: ["sb_cut"],
			failed: [],
			skipped: [],
		});
		fireEvent.click(screen.getByRole("button", { name: "Apply approved (1)" }));
		await waitFor(() => expect(stored().timeline.trimRanges).toHaveLength(1));
		expect(bridge.directorApply).toHaveBeenCalledTimes(1);
		expect(bridge.directorApply.mock.calls[0][1]).toEqual(["sb_cut"]);
		expect(stored().storyboard?.suggestions[0].status).toBe("applied");
		expect(screen.getByText("Applied")).toBeInTheDocument();
	});

	it("removes silences in one click, sending only the open silence cuts", async () => {
		const doc: AxcutDocument = { ...fixture(), storyboard: storyboard() };
		bridge.directorApply.mockResolvedValue({
			success: true,
			document: doc,
			applied: ["sb_cut"],
			failed: [],
			skipped: [],
		});
		show(doc);
		fireEvent.click(screen.getByRole("button", { name: "Remove silences (1)" }));
		await waitFor(() => expect(bridge.directorApply).toHaveBeenCalledTimes(1));
		expect(bridge.directorApply.mock.calls[0][1]).toEqual(["sb_cut"]);
	});

	it("rejects, then clears the storyboard only after confirming", async () => {
		show({ ...fixture(), storyboard: storyboard() });
		fireEvent.click(screen.getAllByRole("button", { name: "Reject" })[1]);
		await waitFor(() => expect(stored().storyboard?.suggestions[1].status).toBe("rejected"));

		fireEvent.click(screen.getByRole("button", { name: "Clear storyboard" }));
		expect(stored().storyboard).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Keep" }));
		expect(stored().storyboard).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: "Clear storyboard" }));
		fireEvent.click(screen.getAllByRole("button", { name: "Clear storyboard" })[0]);
		await waitFor(() => expect(stored().storyboard).toBeUndefined());
	});

	it("disables analysis while the timeline has no footage", () => {
		show(createEmptyDocument({ projectId: "p1", title: "Empty" }));
		expect(screen.getByRole("button", { name: "Analyse recording" })).toBeDisabled();
		expect(screen.getByText("Add a recording to the timeline first.")).toBeInTheDocument();
	});
});
