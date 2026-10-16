// The Privacy Guardian's pane: scan the recordings for sensitive text, review what was
// found, blur the accepted findings, mark the review done.
//
// A finding shows a MASKED preview only: the pane never has the value to show. On-screen
// findings can be blurred (through the agent tools, in the main process); spoken ones can
// only be pointed at — the playhead jumps there, and the transcript pane is where words
// are cut. Nothing is written to the film until the user accepts a finding.

import { Check, Eye, Play, ShieldCheck, X } from "lucide-react";
import { useScopedT } from "@/contexts/I18nContext";
import { exportGateState, privacyCounts } from "@/lib/ai-edition/privacy/review";
import type { AxcutPrivacyFinding, AxcutPrivacyFindingKind } from "@/lib/ai-edition/schema";
import { usePrivacy } from "@/lib/ai-edition/store/usePrivacy";
import { formatMs } from "@/lib/ai-edition/timeline/format";
import styles from "./NewEditorShell.module.css";
import { Pane } from "./RightPanes";

/** A finding's first appearance on the ruler, for the seek: its first box, via the clip it lies in. */
function firstRulerSec(
	finding: AxcutPrivacyFinding,
	clips: Array<{
		assetId: string;
		sourceStartSec: number;
		sourceEndSec?: number;
		timelineStartSec: number;
		timelineEndSec: number;
	}>,
): number | null {
	const sourceSec =
		finding.source === "transcript"
			? (finding.spokenStartSec ?? null)
			: finding.boxes.length > 0
				? finding.boxes[0].timeMs / 1000
				: null;
	if (sourceSec === null) return null;
	for (const clip of clips) {
		if (clip.assetId !== finding.assetId) continue;
		const end =
			clip.sourceEndSec ?? clip.sourceStartSec + (clip.timelineEndSec - clip.timelineStartSec);
		if (sourceSec >= clip.sourceStartSec && sourceSec <= end) {
			return clip.timelineStartSec + (sourceSec - clip.sourceStartSec);
		}
	}
	return null;
}

export function PrivacyPane() {
	const te = useScopedT("editor");
	const {
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
	} = usePrivacy();
	const counts = privacyCounts(review);
	const gate = document ? exportGateState(document) : null;
	const hasFootage = (document?.timeline.clips.length ?? 0) > 0;
	const idle = busy === "idle";
	const findings = review?.scan?.findings ?? [];
	const openOnScreen = findings.filter(
		(f) => f.status === "suggested" && f.source === "frame",
	).length;

	const kindLabel: Record<AxcutPrivacyFindingKind, string> = {
		"api-key": te("privacy.kind.apiKey"),
		token: te("privacy.kind.token"),
		"private-key": te("privacy.kind.privateKey"),
		"secret-assignment": te("privacy.kind.secretAssignment"),
		"url-credential": te("privacy.kind.urlCredential"),
		email: te("privacy.kind.email"),
		phone: te("privacy.kind.phone"),
		card: te("privacy.kind.card"),
		iban: te("privacy.kind.iban"),
		ip: te("privacy.kind.ip"),
	};
	const statusLabel: Record<AxcutPrivacyFinding["status"], string> = {
		suggested: te("privacy.status.suggested"),
		accepted: te("privacy.status.accepted"),
		dismissed: te("privacy.status.dismissed"),
	};
	const gateLabel = gate
		? {
				unscanned: te("privacy.gate.unscanned"),
				stale: te("privacy.gate.stale"),
				unreviewed: te("privacy.gate.unreviewed", { count: gate.suggested }),
				reviewed: te("privacy.gate.reviewed"),
				clear: te("privacy.gate.clear"),
			}[gate.state]
		: "";

	const scanLabel = () => {
		if (busy === "scanning") {
			return progress && progress.total > 0
				? te("privacy.scanningProgress", { done: progress.done, total: progress.total })
				: te("privacy.scanning");
		}
		return review?.scan ? te("privacy.rescan") : te("privacy.scan");
	};

	return (
		<Pane
			title={te("privacy.title")}
			icon={<ShieldCheck size={16} />}
			helpText={te("privacy.help")}
		>
			<p className={styles.sbIntro}>{te("privacy.intro")}</p>
			{status ? (
				<p className={styles.sbNote}>
					{!status.ffmpegPresent
						? te("privacy.noFfmpeg")
						: !status.ocrAvailable
							? te("privacy.noOcr")
							: status.modelPresent
								? te("privacy.modelReady")
								: te("privacy.modelDownload")}
				</p>
			) : null}
			<div className={styles.sbActions}>
				<button
					type="button"
					className={styles.secondaryBtn}
					style={{ margin: 0 }}
					disabled={!idle || !hasFootage}
					onClick={() => void scan()}
				>
					{scanLabel()}
				</button>
				{busy === "scanning" ? (
					<button type="button" className={styles.rowAction} onClick={() => void cancelScan()}>
						{te("privacy.stopScan")}
					</button>
				) : null}
			</div>
			{!hasFootage ? <p className={styles.sbNote}>{te("privacy.noFootage")}</p> : null}

			{review?.scan ? (
				<>
					<p className={styles.sbSummary} data-gate={gate?.state}>
						{gateLabel}
					</p>
					<p className={styles.sbNote}>
						{te("privacy.scanSummary", {
							frames: review.scan.framesScanned,
							found: counts.total,
							open: counts.suggested,
						})}
						{review.scan.ocrAvailable ? "" : ` ${te("privacy.transcriptOnly")}`}
					</p>
					{review.scan.warnings.map((warning) => (
						<p key={warning} className={styles.sbWarning} role="status">
							{warning}
						</p>
					))}
					<div className={styles.sbActions}>
						<button
							type="button"
							className={styles.rowAction}
							disabled={!idle || openOnScreen === 0}
							onClick={() => void blurAllOpen()}
						>
							{busy === "applying"
								? te("privacy.blurring")
								: te("privacy.blurAll", { count: openOnScreen })}
						</button>
						<button
							type="button"
							className={styles.rowAction}
							disabled={!idle || gate?.state === "reviewed" || gate?.state === "clear"}
							onClick={() => void markDone()}
						>
							{te("privacy.markReviewed")}
						</button>
					</div>

					{findings.length === 0 ? (
						<p className={styles.sbNote}>{te("privacy.nothingFound")}</p>
					) : (
						findings.map((finding) => {
							const at = document ? firstRulerSec(finding, document.timeline.clips) : null;
							return (
								<div key={finding.id} className={styles.sbSuggestion} data-status={finding.status}>
									<div className={styles.sbSuggestionMain}>
										<span className={styles.sbKind}>{kindLabel[finding.kind]}</span>
										<code className={styles.sbDetail}>{finding.preview}</code>
										<span className={styles.sbConfidence}>
											{te("privacy.confidence", { percent: Math.round(finding.confidence * 100) })}
										</span>
										<span className={styles.sbRationale}>
											{finding.source === "frame"
												? te("privacy.seenOnScreen", {
														count: finding.boxes.length,
														time: formatMs(finding.boxes[0]?.timeMs ?? 0),
													})
												: te("privacy.spokenAt", {
														time: formatMs((finding.spokenStartSec ?? 0) * 1000),
													})}
										</span>
										{finding.error ? (
											<span className={styles.sbError} role="alert">
												{finding.error}
											</span>
										) : null}
									</div>
									<div className={styles.sbSuggestionActions}>
										<span className={styles.sbStatus}>{statusLabel[finding.status]}</span>
										{at !== null ? (
											<button
												type="button"
												className={styles.sbDecision}
												aria-label={te("privacy.jumpTo", { time: formatMs(at * 1000) })}
												title={te("privacy.jumpTo", { time: formatMs(at * 1000) })}
												onClick={() => seek(at)}
											>
												<Play size={14} />
											</button>
										) : null}
										{finding.status === "suggested" && finding.source === "frame" ? (
											<button
												type="button"
												className={styles.rowAction}
												disabled={!idle}
												onClick={() => void blur([finding.id])}
											>
												<Eye size={14} />
												{te("privacy.blur")}
											</button>
										) : null}
										{finding.status !== "accepted" ? (
											<button
												type="button"
												className={`${styles.sbDecision} ${finding.status === "dismissed" ? styles.isOn : ""}`}
												aria-pressed={finding.status === "dismissed"}
												aria-label={te("privacy.dismiss")}
												title={te("privacy.dismiss")}
												disabled={!idle}
												onClick={() =>
													void decide(
														[finding.id],
														finding.status === "dismissed" ? "suggested" : "dismissed",
													)
												}
											>
												{finding.status === "dismissed" ? <Check size={14} /> : <X size={14} />}
											</button>
										) : null}
									</div>
								</div>
							);
						})
					)}
				</>
			) : null}
		</Pane>
	);
}
