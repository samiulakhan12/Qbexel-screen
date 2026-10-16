import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { useScopedT } from "@/contexts/I18nContext";

/** Bytes as a short human size: the toast says how much of the take is on disk. */
export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** At most this many takes are offered at once; older leftovers stay for the next launch. */
export const MAX_OFFERED_TAKES = 3;

/**
 * Offers back the takes a previous run left unfinished (electron/recording/takeJournal.ts).
 * Mounted once by the HUD: each take is one persistent toast with Recover and Discard. Recover
 * hands the take to the editor through the main process; Discard forgets the marker and leaves
 * the video where it is, unless it is empty.
 */
export function useInterruptedTakesNotice(): void {
	const t = useScopedT("launch");
	const offered = useRef(false);

	useEffect(() => {
		if (offered.current) return;
		offered.current = true;
		const api = window.electronAPI;
		if (!api?.scanInterruptedTakes) return;
		let cancelled = false;
		void api
			.scanInterruptedTakes()
			.then((takes) => {
				if (cancelled) return;
				for (const take of takes.slice(0, MAX_OFFERED_TAKES)) {
					const when = new Date(take.startedAt).toLocaleString();
					const empty = take.screenBytes === 0;
					const id = toast.warning(t("interruptedTakes.title"), {
						duration: Number.POSITIVE_INFINITY,
						description: empty
							? t("interruptedTakes.emptyDescription", { when })
							: t("interruptedTakes.description", { when, size: formatBytes(take.screenBytes) }),
						...(empty
							? {}
							: {
									action: {
										label: t("interruptedTakes.recover"),
										onClick: () => {
											void api.recoverInterruptedTake?.(take.markerPath).then((result) => {
												if (result?.success) {
													toast.success(t("interruptedTakes.recovered"));
												} else {
													toast.error(
														t("interruptedTakes.failed", { error: result?.error ?? "unknown" }),
													);
												}
											});
										},
									},
								}),
						cancel: {
							label: t("interruptedTakes.discard"),
							onClick: () => {
								void api.forgetInterruptedTake?.(take.markerPath);
								toast.dismiss(id);
							},
						},
					});
				}
			})
			.catch((error) => {
				console.warn("[interrupted-takes] could not scan the recordings folder:", error);
			});
		return () => {
			cancelled = true;
		};
	}, [t]);
}
