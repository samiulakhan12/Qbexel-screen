// A project's referential health, beyond what the schema can say: clips point at assets,
// anchored regions at clips, transcripts and storyboard suggestions at things that exist,
// and the media is still where the project says. Pure, with the file check injected, so
// the CLI's `validate`, the MCP's `validateProject` and tests all run the same list.

import type { AxcutDocument } from "../schema";

export interface ProjectProblem {
	kind: string;
	message: string;
}

export async function validateProjectDocument(
	document: AxcutDocument,
	fileExists: (filePath: string) => Promise<boolean>,
): Promise<ProjectProblem[]> {
	const problems: ProjectProblem[] = [];
	const assetIds = new Set(document.assets.map((asset) => asset.id));
	const clipIds = new Set(document.timeline.clips.map((clip) => clip.id));
	for (const clip of document.timeline.clips) {
		if (!assetIds.has(clip.assetId)) {
			problems.push({
				kind: "clip-asset",
				message: `Clip ${clip.id} uses unknown asset ${clip.assetId}.`,
			});
		}
		if (clip.timelineEndSec <= clip.timelineStartSec) {
			problems.push({ kind: "clip-empty", message: `Clip ${clip.id} has no length on the ruler.` });
		}
	}
	const anchored: Array<[string, ReadonlyArray<{ id: string; clipId?: string }>]> = [
		["zoom", document.zoomRanges],
		["annotation", document.annotations],
		["trim", document.timeline.trimRanges],
		["effect", document.shaderEffectRanges ?? []],
	];
	for (const [kind, regions] of anchored) {
		for (const region of regions) {
			if (region.clipId && !clipIds.has(region.clipId)) {
				problems.push({
					kind: `${kind}-anchor`,
					message: `${kind} ${region.id} is anchored to missing clip ${region.clipId}.`,
				});
			}
		}
	}
	for (const transcript of document.transcripts) {
		if (!assetIds.has(transcript.assetId)) {
			problems.push({
				kind: "transcript-asset",
				message: `A transcript refers to unknown asset ${transcript.assetId}.`,
			});
		}
	}
	if (document.storyboard) {
		const sceneIds = new Set(document.storyboard.scenes.map((scene) => scene.id));
		for (const suggestion of document.storyboard.suggestions) {
			if (!sceneIds.has(suggestion.sceneId)) {
				problems.push({
					kind: "storyboard-scene",
					message: `Suggestion ${suggestion.id} refers to missing scene ${suggestion.sceneId}.`,
				});
			}
		}
	}
	for (const asset of document.assets) {
		if (!asset.originalPath) continue;
		if (!(await fileExists(asset.originalPath))) {
			problems.push({
				kind: "media-missing",
				message: `Media of asset ${asset.id} (${asset.label}) is not at its path.`,
			});
		}
	}
	return problems;
}
