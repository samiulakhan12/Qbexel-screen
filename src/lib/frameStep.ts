/** One frame in seconds at 60 FPS (~16.67ms), the step when the footage's rate is unknown. */
export const FRAME_DURATION_SEC = 1 / 60;

/** Frame rates a recording can plausibly carry; anything else reads as unknown. */
const MIN_FPS = 1;
const MAX_FPS = 240;

/** One frame in seconds at `fps`, or the 60 FPS step for a missing or absurd rate. */
export function frameDurationSec(fps: number | null | undefined): number {
	if (typeof fps !== "number" || !Number.isFinite(fps) || fps < MIN_FPS || fps > MAX_FPS) {
		return FRAME_DURATION_SEC;
	}
	return 1 / fps;
}

/** New playhead time after stepping one frame, clamped to [0, duration]. */
export function computeFrameStepTime(
	currentTime: number,
	duration: number,
	direction: "forward" | "backward",
	fps?: number | null,
): number {
	const step = frameDurationSec(fps);
	const delta = direction === "forward" ? step : -step;
	return Math.min(duration, Math.max(0, currentTime + delta));
}

/**
 * The frame rate of the footage under the playhead: the clip at `rawSec` names its asset, and
 * the asset carries the rate the probe found. Falls back to the first clip's asset, then to
 * nothing, so a project with no probed media steps at 60 FPS.
 */
export function fpsAtTime(
	document: {
		assets: Array<{ id: string; video?: { fps?: number } }>;
		timeline: {
			clips: Array<{ assetId: string; timelineStartSec: number; timelineEndSec: number }>;
		};
	},
	rawSec: number,
): number | null {
	const clips = document.timeline.clips;
	const clip =
		clips.find((c) => rawSec >= c.timelineStartSec && rawSec < c.timelineEndSec) ??
		clips[clips.length - 1] ??
		null;
	if (!clip) return null;
	const fps = document.assets.find((a) => a.id === clip.assetId)?.video?.fps;
	return typeof fps === "number" && fps > 0 ? fps : null;
}
