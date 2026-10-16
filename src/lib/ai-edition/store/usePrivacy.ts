// The Privacy pane's store: run a scan, decide on findings, blur the accepted ones,
// mark the review done. Every write goes through `saveDocument` with history, and the
// document sent to main is always the store's current one (see `useStoryboard` for why).

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { useScopedT } from "@/contexts/I18nContext";
import { nativeBridgeClient } from "@/native/client";
import type { PrivacyScanProgressEvent, PrivacyStatus } from "@/native/contracts";
import { emptyPrivacyReview, markReviewed, setFindingStatuses } from "../privacy/review";
import {
	type AxcutDocument,
	type AxcutPrivacyFinding,
	type AxcutPrivacyReview,
	documentSchema,
	privacyScanSchema,
} from "../schema";
import { useProjectStore } from "./projectStore";

export type PrivacyBusy = "idle" | "scanning" | "applying";

export function usePrivacy() {
	const document = useProjectStore((s) => s.document);
	const projectId = useProjectStore((s) => s.projectId);
	const saveDocument = useProjectStore((s) => s.saveDocument);
	const setCurrentTime = useProjectStore((s) => s.setCurrentTime);
	const te = useScopedT("editor");
	const [busy, setBusy] = useState<PrivacyBusy>("idle");
	const [progress, setProgress] = useState<PrivacyScanProgressEvent | null>(null);
	const [status, setStatus] = useState<PrivacyStatus | null>(null);

	const review: AxcutPrivacyReview | null = document?.privacy ?? null;

	useEffect(() => {
		let cancelled = false;
		nativeBridgeClient.privacy
			.status()
			.then((next) => {
				if (!cancelled) setStatus(next);
			})
			.catch(() => {
				if (!cancelled) setStatus(null);
			});
		const unsubscribe = window.electronAPI?.onPrivacyScanProgress?.((event) => {
			setProgress(event);
		});
		return () => {
			cancelled = true;
			unsubscribe?.();
		};
	}, []);

	const current = useCallback((): AxcutDocument | null => {
		const state = useProjectStore.getState();
		if (!state.document || state.projectId !== projectId) return null;
		return state.document;
	}, [projectId]);

	const scan = useCallback(async (): Promise<boolean> => {
		const doc = current();
		if (!doc) return false;
		setBusy("scanning");
		setProgress(null);
		try {
			const result = await nativeBridgeClient.privacy.scan(doc);
			if (!result.success) {
				toast.error(te("privacy.scanFailed", { error: result.error ?? "" }));
				return false;
			}
			const parsed = privacyScanSchema.safeParse(result.scan);
			if (!parsed.success) {
				toast.error(te("privacy.scanFailed", { error: parsed.error.message }));
				return false;
			}
			const fresh = current();
			if (!fresh) return false;
			const previous = fresh.privacy ?? emptyPrivacyReview();
			const saved = await saveDocument(
				{
					...fresh,
					privacy: {
						...previous,
						scan: parsed.data,
						reviewedAt: null,
						reviewedClipSignature: null,
					},
				},
				{ history: true },
			);
			if (saved && result.cancelled) toast.info(te("privacy.scanStopped"));
			return saved;
		} catch (error) {
			toast.error(
				te("privacy.scanFailed", { error: error instanceof Error ? error.message : String(error) }),
			);
			return false;
		} finally {
			setBusy("idle");
			setProgress(null);
		}
	}, [current, saveDocument, te]);

	const cancelScan = useCallback(async () => {
		try {
			await nativeBridgeClient.privacy.cancelScan();
		} catch {
			// The scan ends on its own.
		}
	}, []);

	const decide = useCallback(
		async (ids: readonly string[], decision: AxcutPrivacyFinding["status"]): Promise<boolean> => {
			const doc = current();
			if (!doc?.privacy?.scan) return false;
			return saveDocument(
				{ ...doc, privacy: setFindingStatuses(doc.privacy, new Set(ids), decision) },
				{ history: true },
			);
		},
		[current, saveDocument],
	);

	/** Blur the named findings (accepting them). */
	const blur = useCallback(
		async (ids: readonly string[]): Promise<{ applied: number; failed: number } | null> => {
			const doc = current();
			if (!doc?.privacy?.scan || ids.length === 0) return null;
			setBusy("applying");
			try {
				const result = await nativeBridgeClient.privacy.apply(doc, [...ids]);
				if (!result.success || result.document === undefined) {
					toast.error(te("privacy.applyError", { error: result.error ?? "" }));
					return null;
				}
				const parsed = documentSchema.safeParse(result.document);
				if (!parsed.success) {
					toast.error(te("privacy.applyError", { error: parsed.error.message }));
					return null;
				}
				if (!current()) return null;
				if (!(await saveDocument(parsed.data, { history: true }))) return null;
				const outcome = { applied: result.applied.length, failed: result.failed.length };
				if (outcome.applied > 0) toast.success(te("privacy.blurred", { count: outcome.applied }));
				if (outcome.failed > 0) toast.warning(te("privacy.blurFailed", { count: outcome.failed }));
				return outcome;
			} catch (error) {
				toast.error(
					te("privacy.applyError", {
						error: error instanceof Error ? error.message : String(error),
					}),
				);
				return null;
			} finally {
				setBusy("idle");
			}
		},
		[current, saveDocument, te],
	);

	/** Blur every open on-screen finding at once. */
	const blurAllOpen = useCallback(async () => {
		const doc = current();
		if (!doc?.privacy?.scan) return null;
		const ids = doc.privacy.scan.findings
			.filter((finding) => finding.status === "suggested" && finding.source === "frame")
			.map((finding) => finding.id);
		if (ids.length === 0) return null;
		return blur(ids);
	}, [blur, current]);

	const markDone = useCallback(async (): Promise<boolean> => {
		const doc = current();
		if (!doc?.privacy?.scan) return false;
		return saveDocument({ ...doc, privacy: markReviewed(doc.privacy, doc) }, { history: true });
	}, [current, saveDocument]);

	const seek = useCallback((sec: number) => setCurrentTime(Math.max(0, sec)), [setCurrentTime]);

	return {
		document,
		review,
		status,
		busy,
		progress,
		scan,
		cancelScan,
		decide,
		blur,
		blurAllOpen,
		markDone,
		seek,
	};
}
