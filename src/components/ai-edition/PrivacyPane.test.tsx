// @vitest-environment jsdom

// The Privacy pane against a mocked bridge: a scan lands on the document, findings show
// masked, decisions and blurs are saved, and the review mark is a click.

import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import {
	type AxcutDocument,
	type AxcutPrivacyReview,
	createEmptyDocument,
	documentSchema,
} from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { PrivacyPane } from "./PrivacyPane";

const bridge = vi.hoisted(() => ({
	aiEdition: { save: vi.fn() },
	privacy: {
		status: vi.fn(),
		scan: vi.fn(),
		cancelScan: vi.fn(),
		apply: vi.fn(),
		scanFile: vi.fn(),
	},
}));
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

function review(): AxcutPrivacyReview {
	return {
		version: 1,
		scan: {
			id: "scan_1",
			at: "2026-10-16T00:00:00.000Z",
			strategies: ["transcript", "ocr"],
			ocrAvailable: true,
			sampleEveryMs: 2000,
			framesScanned: 15,
			assetIds: ["asset_1"],
			findings: [
				{
					id: "pf_email",
					kind: "email",
					preview: "j••••••e@example.com",
					confidence: 0.86,
					source: "frame",
					assetId: "asset_1",
					boxes: [{ timeMs: 4000, x: 0.15, y: 0.4, w: 0.3, h: 0.05 }],
					status: "suggested",
					annotationIds: [],
				},
				{
					id: "pf_card",
					kind: "card",
					preview: "•••• 1111",
					confidence: 0.68,
					source: "transcript",
					assetId: "asset_1",
					boxes: [],
					spokenStartSec: 12,
					spokenEndSec: 14,
					status: "suggested",
					annotationIds: [],
				},
			],
			warnings: [],
		},
		reviewedAt: null,
		reviewedClipSignature: null,
	};
}

function show(document: AxcutDocument) {
	useProjectStore.setState({ document, projectId: "p1" });
	render(
		<I18nProvider>
			<PrivacyPane />
		</I18nProvider>,
	);
}

const stored = () => useProjectStore.getState().document as AxcutDocument;

beforeEach(() => {
	for (const fn of Object.values(bridge.privacy)) fn.mockReset();
	bridge.aiEdition.save.mockReset();
	bridge.aiEdition.save.mockImplementation(async (document: unknown) => ({
		success: true,
		document,
	}));
	bridge.privacy.status.mockResolvedValue({
		ocrAvailable: true,
		modelPresent: true,
		ffmpegPresent: true,
	});
});

afterEach(() => {
	cleanup();
	useProjectStore.getState().clear();
});

describe("PrivacyPane", () => {
	it("runs a scan and saves it onto the document, showing findings masked", async () => {
		bridge.privacy.scan.mockResolvedValue({ success: true, scan: review().scan });
		show(fixture());
		await waitFor(() =>
			expect(screen.getByText(/recognition model is installed/)).toBeInTheDocument(),
		);
		fireEvent.click(screen.getByRole("button", { name: "Scan recording" }));
		await waitFor(() => expect(stored().privacy?.scan?.findings).toHaveLength(2));
		expect(bridge.privacy.scan).toHaveBeenCalledTimes(1);
		expect(screen.getByText("j••••••e@example.com")).toBeInTheDocument();
		expect(screen.queryByText(/jane\.doe/)).not.toBeInTheDocument();
		expect(screen.getByText("2 findings still need a decision.")).toBeInTheDocument();
		expect(screen.getByText(/Spoken at 0:12\.0/)).toBeInTheDocument();
	});

	it("blurs an on-screen finding through the bridge and keeps the returned document", async () => {
		const document: AxcutDocument = { ...fixture(), privacy: review() };
		const blurred: AxcutDocument = {
			...document,
			annotations: [
				{
					id: "ann_blur",
					startMs: 3500,
					endMs: 6500,
					type: "blur",
					content: "",
					textContent: "",
					position: { x: 10, y: 10 },
					size: { width: 30, height: 5 },
					style: {
						color: "#fff",
						backgroundColor: "transparent",
						fontSize: 32,
						fontFamily: "Inter",
						fontWeight: "bold",
						fontStyle: "normal",
						textDecoration: "none",
						textAlign: "center",
						textAnimation: "none",
					},
					zIndex: 1,
				} as AxcutDocument["annotations"][number],
			],
			privacy: {
				...review(),
				scan: {
					...review().scan!,
					findings: review().scan!.findings.map((f) =>
						f.id === "pf_email" ? { ...f, status: "accepted", annotationIds: ["ann_blur"] } : f,
					),
				},
			},
		};
		bridge.privacy.apply.mockResolvedValue({
			success: true,
			document: blurred,
			applied: ["pf_email"],
			failed: [],
			skipped: [],
		});
		show(document);
		// Only the on-screen finding offers a blur; the spoken one cannot be covered.
		expect(screen.getAllByRole("button", { name: /^Blur$/ })).toHaveLength(1);
		fireEvent.click(screen.getByRole("button", { name: /^Blur$/ }));
		await waitFor(() => expect(stored().annotations).toHaveLength(1));
		expect(bridge.privacy.apply.mock.calls[0][1]).toEqual(["pf_email"]);
		expect(screen.getByText("Blurred")).toBeInTheDocument();
	});

	it("dismisses a finding and lets the user mark the review done", async () => {
		show({ ...fixture(), privacy: review() });
		fireEvent.click(screen.getAllByRole("button", { name: "Dismiss" })[1]);
		await waitFor(() => expect(stored().privacy?.scan?.findings[1].status).toBe("dismissed"));
		fireEvent.click(screen.getByRole("button", { name: "Mark as reviewed" }));
		await waitFor(() => expect(stored().privacy?.reviewedAt).toBeTruthy());
		expect(screen.getByText("Reviewed.")).toBeInTheDocument();
	});

	it("says what the machine can do before the first scan", async () => {
		bridge.privacy.status.mockResolvedValue({
			ocrAvailable: true,
			modelPresent: false,
			ffmpegPresent: false,
		});
		show(fixture());
		await waitFor(() => expect(screen.getByText(/ffmpeg is missing/)).toBeInTheDocument());
	});
});
