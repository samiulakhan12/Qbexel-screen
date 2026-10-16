// The Tutorial Director's pane: run the analysis, read the storyboard, review each
// suggestion, apply what was approved.
//
// Two rules the layout enforces rather than states. Observed facts (narration, clicks,
// silences) and inferences (titles, summaries, retake notes) sit in separate blocks under
// separate tags, so a guess never reads as a fact. And nothing is written to the film
// until the user approves it: the only writes from here are the analysis itself (a
// storyboard on the document), review decisions, and the application of approved
// suggestions through the agent tools in the main process.

import { Check, Clapperboard, Play, X } from "lucide-react";
import { useState } from "react";
import { useScopedT } from "@/contexts/I18nContext";
import { isStoryboardStale, storyboardCounts } from "@/lib/ai-edition/director/storyboard";
import type {
	AxcutStoryboardInference,
	AxcutStoryboardObservedEvent,
	AxcutStoryboardScene,
	AxcutStoryboardSuggestion,
} from "@/lib/ai-edition/schema";
import { useStoryboard } from "@/lib/ai-edition/store/useStoryboard";
import { formatMs } from "@/lib/ai-edition/timeline/format";
import styles from "./NewEditorShell.module.css";
import { Pane, Toggle } from "./RightPanes";

export function StoryboardPane() {
	const te = useScopedT("editor");
	const {
		document,
		storyboard,
		busy,
		warning,
		analyze,
		setStatus,
		approveAll,
		apply,
		applyApproved,
		removeSilences,
		clearStoryboard,
		seek,
	} = useStoryboard();
	// Off by default and never remembered: sending the narration to a provider is a choice
	// made for each run, not a setting that outlives it.
	const [enrich, setEnrich] = useState(false);
	const [confirmClear, setConfirmClear] = useState(false);

	const counts = storyboardCounts(storyboard);
	const stale = storyboard && document ? isStoryboardStale(storyboard, document) : false;
	const hasFootage = (document?.timeline.clips.length ?? 0) > 0;
	const idle = busy === "idle";
	const open = counts.proposed + counts.approved;

	const eventLabel: Record<AxcutStoryboardObservedEvent["kind"], string> = {
		click: te("director.events.click"),
		"double-click": te("director.events.doubleClick"),
		"right-click": te("director.events.rightClick"),
		silence: te("director.events.silence"),
	};
	const kindLabel: Record<AxcutStoryboardSuggestion["kind"], string> = {
		cut: te("director.suggestion.cut"),
		zoom: te("director.suggestion.zoom"),
		callout: te("director.suggestion.callout"),
		titleCard: te("director.suggestion.titleCard"),
	};
	const statusLabel: Record<AxcutStoryboardSuggestion["status"], string> = {
		proposed: te("director.status.proposed"),
		approved: te("director.status.approved"),
		rejected: te("director.status.rejected"),
		applied: te("director.status.applied"),
	};
	const reasonLabel = {
		silence: te("director.cutReason.silence"),
		"lead-in": te("director.cutReason.leadIn"),
		tail: te("director.cutReason.tail"),
		retake: te("director.cutReason.retake"),
	} as const;
	const cardLabel = { intro: te("director.cardKind.intro"), outro: te("director.cardKind.outro") };
	const inferenceKindLabel: Record<AxcutStoryboardInference["kind"], string> = {
		title: te("director.inferenceKind.title"),
		summary: te("director.inferenceKind.summary"),
		step: te("director.inferenceKind.step"),
		retake: te("director.inferenceKind.retake"),
	};

	const describe = (suggestion: AxcutStoryboardSuggestion): string => {
		switch (suggestion.kind) {
			case "cut":
				return te("director.cutDetail", {
					from: formatMs(suggestion.sourceStartSec * 1000),
					to: formatMs(suggestion.sourceEndSec * 1000),
					reason: reasonLabel[suggestion.reason],
				});
			case "zoom":
				return te("director.zoomDetail", {
					from: formatMs(suggestion.startMs),
					to: formatMs(suggestion.endMs),
					depth: suggestion.depth,
				});
			case "callout":
				return te("director.calloutDetail", {
					text: suggestion.text,
					time: formatMs(suggestion.startMs),
				});
			case "titleCard":
				return te("director.titleCardDetail", {
					kind: cardLabel[suggestion.cardKind],
					text: suggestion.text,
				});
		}
	};

	const describeEvent = (event: AxcutStoryboardObservedEvent): string =>
		event.kind === "silence"
			? te("director.silenceSpan", {
					from: formatMs(event.atMs),
					to: formatMs(event.endMs ?? event.atMs),
				})
			: te("director.eventAt", { kind: eventLabel[event.kind], time: formatMs(event.atMs) });

	const renderScene = (scene: AxcutStoryboardScene) => {
		const suggestions = storyboard?.suggestions.filter((s) => s.sceneId === scene.id) ?? [];
		return (
			<section key={scene.id} className={styles.sbScene} aria-label={scene.title}>
				<button
					type="button"
					className={styles.sbSceneHead}
					onClick={() => seek(scene.startMs)}
					title={te("director.jumpTo", { time: formatMs(scene.startMs) })}
				>
					<span className={styles.sbSceneIndex}>{scene.order + 1}</span>
					<span className={styles.sbSceneTitle}>{scene.title || te("director.untitled")}</span>
					<span className={styles.sbSceneTime}>
						{formatMs(scene.startMs)} – {formatMs(scene.endMs)}
					</span>
					<Play size={12} aria-hidden="true" />
				</button>

				<div className={styles.sbBlock}>
					<span className={`${styles.sbTag} ${styles.sbTagObserved}`}>
						{te("director.observed")}
					</span>
					<p className={styles.sbNarration}>
						{scene.narration || <em>{te("director.narrationEmpty")}</em>}
					</p>
					{scene.observed.length > 0 ? (
						<ul className={styles.sbEvents}>
							{scene.observed.map((event, index) => (
								<li key={`${event.kind}-${event.atMs}-${index}`}>
									<button
										type="button"
										className={styles.sbEventBtn}
										onClick={() => seek(event.atMs)}
										title={te("director.jumpTo", { time: formatMs(event.atMs) })}
									>
										{describeEvent(event)}
									</button>
								</li>
							))}
						</ul>
					) : null}
				</div>

				{scene.inferred.length > 0 ? (
					<div className={styles.sbBlock}>
						{scene.inferred.map((inference, index) => (
							<div
								key={`${inference.kind}-${inference.source}-${index}`}
								className={styles.sbInference}
							>
								<span
									className={`${styles.sbTag} ${inference.source === "llm" ? styles.sbTagLlm : styles.sbTagHeuristic}`}
									title={inference.model ?? undefined}
								>
									{inference.source === "llm" ? te("director.inferred") : te("director.heuristic")}
								</span>
								<span className={styles.sbInferenceKind}>{inferenceKindLabel[inference.kind]}</span>
								<span className={styles.sbInferenceText}>{inference.text}</span>
								<span className={styles.sbConfidence}>
									{te("director.confidence", { percent: Math.round(inference.confidence * 100) })}
								</span>
							</div>
						))}
					</div>
				) : null}

				{suggestions.map((suggestion) => {
					const decided = suggestion.status === "applied";
					return (
						<div
							key={suggestion.id}
							className={styles.sbSuggestion}
							data-status={suggestion.status}
						>
							<div className={styles.sbSuggestionMain}>
								<span className={styles.sbKind}>{kindLabel[suggestion.kind]}</span>
								<span className={styles.sbDetail}>{describe(suggestion)}</span>
								{suggestion.rationale ? (
									<span className={styles.sbRationale}>{suggestion.rationale}</span>
								) : null}
								{suggestion.error ? (
									<span className={styles.sbError} role="alert">
										{suggestion.error}
									</span>
								) : null}
							</div>
							<div className={styles.sbSuggestionActions}>
								<span className={styles.sbStatus}>{statusLabel[suggestion.status]}</span>
								{decided ? null : (
									<>
										<button
											type="button"
											className={`${styles.sbDecision} ${suggestion.status === "approved" ? styles.isOn : ""}`}
											aria-pressed={suggestion.status === "approved"}
											aria-label={te("director.approve")}
											title={te("director.approve")}
											disabled={!idle}
											onClick={() =>
												void setStatus(
													[suggestion.id],
													suggestion.status === "approved" ? "proposed" : "approved",
												)
											}
										>
											<Check size={14} />
										</button>
										<button
											type="button"
											className={`${styles.sbDecision} ${suggestion.status === "rejected" ? styles.isOn : ""}`}
											aria-pressed={suggestion.status === "rejected"}
											aria-label={te("director.reject")}
											title={te("director.reject")}
											disabled={!idle}
											onClick={() =>
												void setStatus(
													[suggestion.id],
													suggestion.status === "rejected" ? "proposed" : "rejected",
												)
											}
										>
											<X size={14} />
										</button>
										<button
											type="button"
											className={styles.rowAction}
											disabled={!idle || suggestion.status === "rejected"}
											onClick={() => void apply([suggestion.id])}
										>
											{te("director.applyOne")}
										</button>
									</>
								)}
							</div>
						</div>
					);
				})}
			</section>
		);
	};

	return (
		<Pane
			title={te("director.title")}
			icon={<Clapperboard size={16} />}
			helpText={te("director.help")}
		>
			<p className={styles.sbIntro}>{te("director.intro")}</p>
			<div className={styles.paneRow}>
				<div>
					<span className={styles.label}>{te("director.enrich")}</span>
					<span className={styles.info}>{te("director.enrichHint")}</span>
				</div>
				<Toggle
					checked={enrich}
					disabled={!idle}
					ariaLabel={te("director.enrich")}
					onChange={setEnrich}
				/>
			</div>
			<button
				type="button"
				className={styles.secondaryBtn}
				disabled={!idle || !hasFootage}
				onClick={() => void analyze({ enrich })}
			>
				{busy === "analyzing"
					? te("director.analyzing")
					: storyboard
						? te("director.reanalyze")
						: te("director.analyze")}
			</button>
			{!hasFootage ? <p className={styles.sbNote}>{te("director.noFootage")}</p> : null}
			{warning ? (
				<p className={styles.sbWarning} role="status">
					{te("director.enrichWarning", { error: warning })}
				</p>
			) : null}

			{storyboard ? (
				<>
					{stale ? (
						<p className={styles.sbWarning} role="status">
							{te("director.stale")}
						</p>
					) : null}
					<p className={styles.sbSummary}>
						{te("director.summary", {
							scenes: counts.scenes,
							open,
							applied: counts.applied,
						})}
						{storyboard.enrichment ? (
							<span className={styles.sbProvenance}>
								{" · "}
								{te("director.enrichedBy", { model: storyboard.enrichment.model })}
							</span>
						) : null}
					</p>
					<div className={styles.sbActions}>
						<button
							type="button"
							className={styles.rowAction}
							disabled={!idle || counts.proposed === 0}
							onClick={() => void approveAll()}
						>
							{te("director.approveAll")}
						</button>
						<button
							type="button"
							className={styles.rowAction}
							disabled={!idle || counts.approved === 0}
							onClick={() => void applyApproved()}
						>
							{busy === "applying"
								? te("director.applying")
								: te("director.applyApproved", { count: counts.approved })}
						</button>
						<button
							type="button"
							className={styles.rowAction}
							disabled={!idle || counts.silenceCuts === 0}
							onClick={() => void removeSilences()}
						>
							{te("director.removeSilences", { count: counts.silenceCuts })}
						</button>
						{confirmClear ? (
							<span className={styles.sbConfirm}>
								{te("director.clearConfirm")}
								<button
									type="button"
									className={styles.rowAction}
									onClick={() => {
										setConfirmClear(false);
										void clearStoryboard();
									}}
								>
									{te("director.clear")}
								</button>
								<button
									type="button"
									className={styles.rowAction}
									onClick={() => setConfirmClear(false)}
								>
									{te("director.keep")}
								</button>
							</span>
						) : (
							<button
								type="button"
								className={styles.rowAction}
								disabled={!idle}
								onClick={() => setConfirmClear(true)}
							>
								{te("director.clear")}
							</button>
						)}
					</div>
					{storyboard.scenes.length === 0 ? (
						<p className={styles.sbNote}>{te("director.noScenes")}</p>
					) : (
						storyboard.scenes.map(renderScene)
					)}
				</>
			) : null}
		</Pane>
	);
}
