// @vitest-environment jsdom

// The Compositions pane: presets become compositions on the document, edits mark them
// custom, previewing one applies its look to the project, guides toggle, exports hand
// the list to the dialog, removal asks first.

import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import { type AxcutDocument, createEmptyDocument, documentSchema } from "@/lib/ai-edition/schema";
import { getEditorSettings } from "@/lib/ai-edition/store/editorSettings";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { useSafeAreaGuide } from "@/lib/ai-edition/store/safeAreaGuide";
import { CompositionsPane } from "./CompositionsPane";

const bridge = vi.hoisted(() => ({ aiEdition: { save: vi.fn() } }));
vi.mock("@/native", () => ({ nativeBridgeClient: bridge }));
vi.mock("@/native/client", () => ({ nativeBridgeClient: bridge }));
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

const stored = () => useProjectStore.getState().document as AxcutDocument;
let onExport: ReturnType<typeof vi.fn<(list: unknown[]) => void>>;

function show(document: AxcutDocument) {
	useProjectStore.setState({ document, projectId: "p1" });
	render(
		<I18nProvider>
			<CompositionsPane onExport={onExport} />
		</I18nProvider>,
	);
}

beforeEach(() => {
	onExport = vi.fn<(list: unknown[]) => void>();
	bridge.aiEdition.save.mockReset();
	bridge.aiEdition.save.mockImplementation(async (document: unknown) => ({
		success: true,
		document,
	}));
	useSafeAreaGuide.getState().show(null);
});

afterEach(() => {
	cleanup();
	useProjectStore.getState().clear();
});

describe("CompositionsPane", () => {
	it("adds a preset composition to the document and lists it", async () => {
		show(fixture());
		expect(screen.getByText("No compositions yet. Add one above.")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Shorts / Reels" }));
		await waitFor(() => expect(stored().compositions).toHaveLength(1));
		expect(stored().compositions?.[0]).toMatchObject({ preset: "shorts", aspectRatio: "9:16" });
		expect(screen.getByDisplayValue("Shorts / Reels")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Export all (1)" })).toBeInTheDocument();
	});

	it("marks an edited composition custom and keeps the rest of it", async () => {
		show(fixture());
		fireEvent.click(screen.getByRole("button", { name: "YouTube" }));
		await waitFor(() => expect(stored().compositions).toHaveLength(1));
		fireEvent.change(screen.getByLabelText("Frame"), { target: { value: "1:1" } });
		await waitFor(() => expect(stored().compositions?.[0].aspectRatio).toBe("1:1"));
		expect(stored().compositions?.[0].preset).toBe("custom");
		expect(stored().compositions?.[0].export.format).toBe("mp4");
	});

	it("previews a composition by applying its look to the project, and toggles its guides", async () => {
		show(fixture());
		fireEvent.click(screen.getByRole("button", { name: "Shorts / Reels" }));
		await waitFor(() => expect(stored().compositions).toHaveLength(1));
		expect(getEditorSettings(stored()).aspectRatio).not.toBe("9:16");
		fireEvent.click(screen.getByRole("button", { name: "Preview in project" }));
		await waitFor(() => expect(getEditorSettings(stored()).aspectRatio).toBe("9:16"));
		// Previewing shows the guides; the toggle hides them again.
		expect(useSafeAreaGuide.getState().compositionId).toBe(stored().compositions?.[0].id);
		fireEvent.click(screen.getByRole("button", { name: "Hide guides" }));
		expect(useSafeAreaGuide.getState().compositionId).toBeNull();
	});

	it("hands one or all compositions to the export dialog", async () => {
		show(fixture());
		fireEvent.click(screen.getByRole("button", { name: "YouTube" }));
		await waitFor(() => expect(stored().compositions).toHaveLength(1));
		fireEvent.click(screen.getByRole("button", { name: "Docs GIF" }));
		await waitFor(() => expect(stored().compositions).toHaveLength(2));
		fireEvent.click(screen.getAllByRole("button", { name: "Export…" })[1]);
		expect(onExport).toHaveBeenLastCalledWith([expect.objectContaining({ preset: "docs-gif" })]);
		fireEvent.click(screen.getByRole("button", { name: "Export all (2)" }));
		expect(onExport.mock.calls[1][0]).toHaveLength(2);
	});

	it("removes only after confirming", async () => {
		show(fixture());
		fireEvent.click(screen.getByRole("button", { name: "Square" }));
		await waitFor(() => expect(stored().compositions).toHaveLength(1));
		fireEvent.click(screen.getByRole("button", { name: "Remove" }));
		fireEvent.click(screen.getByRole("button", { name: "Keep" }));
		expect(stored().compositions).toHaveLength(1);
		fireEvent.click(screen.getByRole("button", { name: "Remove" }));
		fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[0]);
		await waitFor(() => expect(stored().compositions).toHaveLength(0));
	});
});
