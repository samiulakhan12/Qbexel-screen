// The Compositions pane: the project's output variants, one per place the video goes.
//
// Each row edits one composition's frame, fill, captions, safe area and export settings;
// "Preview in project" applies its look through `documentForComposition` (the export's own
// transform), "Show guides" draws its safe area over the preview, "Export…" opens the export
// dialog for it, and "Export all" hands every composition to the dialog's batch mode.

import { Download, Eye, EyeOff, LayoutTemplate, Trash2 } from "lucide-react";
import { useState } from "react";
import { useScopedT } from "@/contexts/I18nContext";
import { COMPOSITION_PRESET_ORDER } from "@/lib/ai-edition/compositions/presets";
import type { AxcutComposition, AxcutCompositionPreset } from "@/lib/ai-edition/schema";
import { useCompositions } from "@/lib/ai-edition/store/useCompositions";
import { MP4_FRAME_RATES } from "@/lib/exporter/types";
import { ASPECT_RATIO_PRESETS } from "@/utils/aspectRatioUtils";
import styles from "./NewEditorShell.module.css";
import { Pane, Toggle } from "./RightPanes";

export interface CompositionsPaneProps {
	/** Opens the export dialog for one composition, or for all of them (batch). */
	onExport: (compositions: AxcutComposition[]) => void;
}

export function CompositionsPane({ onExport }: CompositionsPaneProps) {
	const ts = useScopedT("settings");
	const { compositions, guideId, add, update, remove, applyToProject, toggleGuide } =
		useCompositions();
	const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

	const presetLabel: Record<AxcutCompositionPreset, string> = {
		youtube: ts("compositions.preset.youtube"),
		shorts: ts("compositions.preset.shorts"),
		square: ts("compositions.preset.square"),
		"docs-gif": ts("compositions.preset.docs-gif"),
		linkedin: ts("compositions.preset.linkedin"),
		custom: ts("compositions.preset.custom"),
	};

	const renderRow = (composition: AxcutComposition) => {
		const safe = composition.safeArea ?? { top: 0, bottom: 0, left: 0, right: 0 };
		const setSafe = (key: keyof typeof safe, value: number) =>
			void update(composition.id, {
				safeArea: { ...safe, [key]: Math.max(0, Math.min(40, value)) },
			});
		const isGif = composition.export.format === "gif";
		return (
			<div key={composition.id} className={styles.compRow} data-testid="composition-row">
				<div className={styles.compHead}>
					<input
						className={styles.compName}
						aria-label={ts("compositions.name")}
						value={composition.name}
						onChange={(event) => void update(composition.id, { name: event.target.value || "—" })}
					/>
					<span className={styles.sbTag}>{presetLabel[composition.preset]}</span>
				</div>
				<div className={styles.compFields}>
					<label className={styles.compField}>
						{ts("compositions.aspect")}
						<select
							value={composition.aspectRatio}
							onChange={(event) => void update(composition.id, { aspectRatio: event.target.value })}
						>
							<option value="auto">{ts("compositions.aspectAuto")}</option>
							{ASPECT_RATIO_PRESETS.map((ratio) => (
								<option key={ratio} value={ratio}>
									{ratio}
								</option>
							))}
							{!ASPECT_RATIO_PRESETS.includes(
								composition.aspectRatio as (typeof ASPECT_RATIO_PRESETS)[number],
							) && composition.aspectRatio !== "auto" ? (
								<option value={composition.aspectRatio}>{composition.aspectRatio}</option>
							) : null}
						</select>
					</label>
					<label className={styles.compField}>
						{ts("compositions.format")}
						<select
							value={composition.export.format}
							onChange={(event) =>
								void update(composition.id, {
									export: { ...composition.export, format: event.target.value as "mp4" | "gif" },
								})
							}
						>
							<option value="mp4">MP4</option>
							<option value="gif">GIF</option>
						</select>
					</label>
					{isGif ? null : (
						<>
							<label className={styles.compField}>
								{ts("compositions.quality")}
								<select
									value={composition.export.quality}
									onChange={(event) =>
										void update(composition.id, {
											export: {
												...composition.export,
												quality: event.target.value as "medium" | "good" | "source",
											},
										})
									}
								>
									<option value="medium">720p</option>
									<option value="good">1080p</option>
									<option value="source">Source</option>
								</select>
							</label>
							<label className={styles.compField}>
								{ts("compositions.fps")}
								<select
									value={composition.export.fps}
									onChange={(event) =>
										void update(composition.id, {
											export: { ...composition.export, fps: Number(event.target.value) },
										})
									}
								>
									{MP4_FRAME_RATES.map((fps) => (
										<option key={fps} value={fps}>
											{fps}
										</option>
									))}
								</select>
							</label>
						</>
					)}
					<label className={styles.compField}>
						{ts("compositions.captionsAnchor")}
						<select
							value={composition.captions?.anchorV ?? "bottom"}
							onChange={(event) =>
								void update(composition.id, {
									captions: {
										...composition.captions,
										anchorV: event.target.value as "bottom" | "top",
									},
								})
							}
						>
							<option value="bottom">{ts("compositions.anchor.bottom")}</option>
							<option value="top">{ts("compositions.anchor.top")}</option>
						</select>
					</label>
					<label className={styles.compField}>
						{ts("compositions.captionsInset")}
						<input
							type="number"
							min={0}
							max={50}
							value={composition.captions?.insetY ?? 0}
							onChange={(event) =>
								void update(composition.id, {
									captions: {
										...composition.captions,
										insetY: Math.max(0, Math.min(50, Number(event.target.value) || 0)),
									},
								})
							}
						/>
					</label>
				</div>
				<div className={styles.paneRow} style={{ margin: 0, padding: "4px 0" }}>
					<span className={styles.label} style={{ fontSize: 12 }}>
						{ts("compositions.fill")}
					</span>
					<Toggle
						checked={composition.formatFollowCursor === true}
						ariaLabel={ts("compositions.fill")}
						onChange={(next) => void update(composition.id, { formatFollowCursor: next })}
					/>
				</div>
				<div className={styles.compField}>
					{ts("compositions.safeArea")}
					<div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6 }}>
						{(["top", "bottom", "left", "right"] as const).map((key) => (
							<input
								key={key}
								type="number"
								min={0}
								max={40}
								aria-label={key}
								value={safe[key]}
								onChange={(event) => setSafe(key, Number(event.target.value) || 0)}
							/>
						))}
					</div>
				</div>
				<div className={styles.compActions}>
					<button
						type="button"
						className={styles.rowAction}
						onClick={() => toggleGuide(composition.id)}
						aria-pressed={guideId === composition.id}
					>
						{guideId === composition.id ? <EyeOff size={14} /> : <Eye size={14} />}
						{guideId === composition.id
							? ts("compositions.hideGuides")
							: ts("compositions.showGuides")}
					</button>
					<button
						type="button"
						className={styles.rowAction}
						onClick={() => void applyToProject(composition.id)}
					>
						{ts("compositions.applyToProject")}
					</button>
					<button
						type="button"
						className={styles.rowAction}
						onClick={() => onExport([composition])}
					>
						<Download size={14} />
						{ts("compositions.export")}
					</button>
					{confirmRemove === composition.id ? (
						<span className={styles.sbConfirm}>
							{ts("compositions.removeConfirm")}
							<button
								type="button"
								className={styles.rowAction}
								onClick={() => {
									setConfirmRemove(null);
									void remove(composition.id);
								}}
							>
								{ts("compositions.remove")}
							</button>
							<button
								type="button"
								className={styles.rowAction}
								onClick={() => setConfirmRemove(null)}
							>
								{ts("compositions.keep")}
							</button>
						</span>
					) : (
						<button
							type="button"
							className={styles.rowAction}
							aria-label={ts("compositions.remove")}
							title={ts("compositions.remove")}
							onClick={() => setConfirmRemove(composition.id)}
						>
							<Trash2 size={14} />
						</button>
					)}
				</div>
			</div>
		);
	};

	return (
		<Pane
			title={ts("compositions.title")}
			icon={<LayoutTemplate size={16} />}
			helpText={ts("compositions.help")}
		>
			<p className={styles.sbIntro}>{ts("compositions.intro")}</p>
			<div className={styles.sectionLabel}>{ts("compositions.add")}</div>
			<div className={styles.sbActions}>
				{COMPOSITION_PRESET_ORDER.map((preset) => (
					<button
						key={preset}
						type="button"
						className={styles.rowAction}
						onClick={() => void add(preset)}
					>
						{presetLabel[preset]}
					</button>
				))}
				<button type="button" className={styles.rowAction} onClick={() => void add("custom")}>
					{ts("compositions.addCustom")}
				</button>
			</div>
			{compositions.length === 0 ? (
				<p className={styles.sbNote}>{ts("compositions.empty")}</p>
			) : (
				<>
					<div className={styles.sbActions}>
						<button
							type="button"
							className={styles.secondaryBtn}
							style={{ margin: 0 }}
							onClick={() => onExport(compositions)}
						>
							<Download size={14} />
							{ts("compositions.exportAll", { count: compositions.length })}
						</button>
						<span className={styles.sbNote} style={{ margin: 0 }}>
							{ts("compositions.exportFileHint")}
						</span>
					</div>
					{compositions.map(renderRow)}
				</>
			)}
		</Pane>
	);
}
