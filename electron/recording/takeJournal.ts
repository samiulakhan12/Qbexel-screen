// The take journal: what a recording leaves on disk while it runs, and what it means after.
//
// A take used to exist on disk only as its growing video file. Nothing said "this file is being
// written", so an app that crashed mid-take left a playable fragmented MP4 that no surface ever
// offered back to the user, and the pauses the user made were folded into the cursor telemetry
// and then thrown away. The journal fixes both with one small sidecar:
//
//   <take>.inprogress.json   written when capture starts, removed when the session manifest is
//                            written or the take is discarded. Its presence at the next launch
//                            is the definition of an interrupted take.
//
// It also keeps the take's EVENTS (start, pause, resume, stop) on two clocks, wall-clock and
// recording time with pauses removed, and the stop handlers copy them into the session manifest,
// so a later tool can tell a deliberate pause from a stretch of silence.
//
// Pure where it can be: the journal takes its clock and filesystem so the tests drive both.

import fs from "node:fs/promises";
import path from "node:path";
import type {
	CursorCaptureMode,
	RecordingEvent,
	RecordingSession,
} from "../../src/lib/recordingSession";

export const IN_PROGRESS_SUFFIX = ".inprogress.json";
export const SESSION_SUFFIX = ".session.json";
export const TAKE_JOURNAL_VERSION = 1;

export type TakeBackend = "windows-wgc" | "macos-sck" | "linux-pipewire" | "browser";

export interface TakeJournalFs {
	writeFile(filePath: string, data: string): Promise<void>;
	rm(filePath: string): Promise<void>;
	rename(from: string, to: string): Promise<void>;
}

const nodeFs: TakeJournalFs = {
	writeFile: (filePath, data) => fs.writeFile(filePath, data, "utf8"),
	rm: (filePath) => fs.rm(filePath, { force: true }),
	rename: (from, to) => fs.rename(from, to),
};

export interface TakeBegin {
	recordingId: number;
	backend: TakeBackend;
	recordingsDir: string;
	screenVideoPath: string;
	webcamVideoPath?: string;
	cursorCaptureMode?: CursorCaptureMode;
}

/** What the in-progress marker holds. Everything a recovery needs to build a session. */
export interface InProgressMarker {
	version: typeof TAKE_JOURNAL_VERSION;
	recordingId: number;
	backend: TakeBackend;
	startedAt: string;
	screenVideoPath: string;
	webcamVideoPath?: string;
	cursorCaptureMode?: CursorCaptureMode;
	events: RecordingEvent[];
}

export interface TakeSummary {
	events: RecordingEvent[];
	/** Pauses in recording time (ms since start, pauses removed), the shape the cursor compaction takes. */
	pauseRanges: Array<{ startMs: number; endMs: number }>;
	/** Recording time at stop, pauses removed. */
	durationMs: number;
}

/** The marker's path for a take, beside its video. */
export function inProgressMarkerPath(recordingsDir: string, screenVideoPath: string): string {
	return path.join(recordingsDir, `${path.parse(screenVideoPath).name}${IN_PROGRESS_SUFFIX}`);
}

export function sessionManifestPath(recordingsDir: string, screenVideoPath: string): string {
	return path.join(recordingsDir, `${path.parse(screenVideoPath).name}${SESSION_SUFFIX}`);
}

/**
 * One take at a time: the recorder never runs two. `begin` replaces whatever was journaled
 * before, so a take that never reached `finish` (the renderer died between stop and manifest)
 * does not leak into the next one's events.
 */
export class TakeJournal {
	private marker: InProgressMarker | null = null;
	private markerPath: string | null = null;
	private startedAtMs = 0;
	private pausedAtMs: number | null = null;
	/** Wall-clock ms spent paused so far, so recording time = wall − paused. */
	private pausedTotalMs = 0;
	private pauseRanges: Array<{ startMs: number; endMs: number }> = [];

	constructor(
		private readonly io: TakeJournalFs = nodeFs,
		private readonly now: () => number = Date.now,
	) {}

	get active(): boolean {
		return this.marker !== null;
	}

	/** Recording time now, pauses removed. */
	recordingTimeMs(at = this.now()): number {
		if (!this.marker) return 0;
		const pausedSoFar =
			this.pausedTotalMs + (this.pausedAtMs !== null ? Math.max(0, at - this.pausedAtMs) : 0);
		return Math.max(0, at - this.startedAtMs - pausedSoFar);
	}

	async begin(take: TakeBegin): Promise<void> {
		const at = this.now();
		this.startedAtMs = at;
		this.pausedAtMs = null;
		this.pausedTotalMs = 0;
		this.pauseRanges = [];
		this.marker = {
			version: TAKE_JOURNAL_VERSION,
			recordingId: take.recordingId,
			backend: take.backend,
			startedAt: new Date(at).toISOString(),
			screenVideoPath: take.screenVideoPath,
			...(take.webcamVideoPath ? { webcamVideoPath: take.webcamVideoPath } : {}),
			...(take.cursorCaptureMode ? { cursorCaptureMode: take.cursorCaptureMode } : {}),
			events: [{ type: "start", atMs: 0, wallClock: new Date(at).toISOString() }],
		};
		this.markerPath = inProgressMarkerPath(take.recordingsDir, take.screenVideoPath);
		await this.persist();
	}

	async pause(): Promise<void> {
		if (!this.marker || this.pausedAtMs !== null) return;
		const at = this.now();
		this.pausedAtMs = at;
		this.marker.events.push({
			type: "pause",
			atMs: this.recordingTimeMs(at),
			wallClock: new Date(at).toISOString(),
		});
		await this.persist();
	}

	async resume(): Promise<void> {
		if (!this.marker || this.pausedAtMs === null) return;
		const at = this.now();
		const pausedFor = Math.max(0, at - this.pausedAtMs);
		const startMs = this.recordingTimeMs(this.pausedAtMs);
		this.pausedTotalMs += pausedFor;
		this.pausedAtMs = null;
		// A pause is a hole in recording time: it starts and ends at the same recording instant.
		// Kept with its wall-clock length in the events; the range is what telemetry readers take.
		this.pauseRanges.push({ startMs, endMs: startMs });
		this.marker.events.push({
			type: "resume",
			atMs: startMs,
			wallClock: new Date(at).toISOString(),
			pausedForMs: pausedFor,
		});
		await this.persist();
	}

	/** Closes the take: appends `stop`, removes the marker, returns what the manifest records. */
	async finish(): Promise<TakeSummary | null> {
		if (!this.marker) return null;
		if (this.pausedAtMs !== null) await this.resume();
		const at = this.now();
		const durationMs = this.recordingTimeMs(at);
		this.marker.events.push({
			type: "stop",
			atMs: durationMs,
			wallClock: new Date(at).toISOString(),
		});
		const summary: TakeSummary = {
			events: this.marker.events,
			pauseRanges: this.pauseRanges,
			durationMs,
		};
		await this.clear();
		return summary;
	}

	/** The take was cancelled or its file removed: nothing to recover later. */
	async discard(): Promise<void> {
		await this.clear();
	}

	private async clear(): Promise<void> {
		const markerPath = this.markerPath;
		this.marker = null;
		this.markerPath = null;
		if (markerPath) {
			try {
				await this.io.rm(markerPath);
			} catch (error) {
				console.warn("[take-journal] could not remove the in-progress marker:", error);
			}
		}
	}

	private async persist(): Promise<void> {
		if (!this.marker || !this.markerPath) return;
		// Temp + rename, like every other sidecar: a crash mid-write must not leave a marker
		// the scan cannot parse, since an unparseable marker is a take nobody is offered.
		const tmp = `${this.markerPath}.tmp-${process.pid}`;
		try {
			await this.io.writeFile(tmp, JSON.stringify(this.marker, null, 2));
			await this.io.rename(tmp, this.markerPath);
		} catch (error) {
			// The journal is a convenience beside the recording, never a reason to fail it.
			console.warn("[take-journal] could not write the in-progress marker:", error);
			await this.io.rm(tmp).catch(() => undefined);
		}
	}
}

/** A take whose marker survived a launch: capture ran, no manifest was written. */
export interface InterruptedTake {
	markerPath: string;
	marker: InProgressMarker;
	/** Bytes of the screen file as found. 0 means the file is empty or missing. */
	screenBytes: number;
	webcamExists: boolean;
}

export interface ScanFs {
	readdir(dir: string): Promise<string[]>;
	readFile(filePath: string): Promise<string>;
	stat(filePath: string): Promise<{ size: number } | null>;
}

const nodeScanFs: ScanFs = {
	readdir: (dir) => fs.readdir(dir),
	readFile: (filePath) => fs.readFile(filePath, "utf8"),
	stat: (filePath) =>
		fs
			.stat(filePath)
			.then((s) => ({ size: s.size }))
			.catch(() => null),
};

function parseMarker(raw: string): InProgressMarker | null {
	try {
		const value = JSON.parse(raw) as Partial<InProgressMarker>;
		if (
			value &&
			typeof value === "object" &&
			value.version === TAKE_JOURNAL_VERSION &&
			typeof value.recordingId === "number" &&
			typeof value.screenVideoPath === "string" &&
			value.screenVideoPath.length > 0 &&
			typeof value.startedAt === "string" &&
			Array.isArray(value.events)
		) {
			return value as InProgressMarker;
		}
	} catch {
		// unparseable: reported by the caller as skipped
	}
	return null;
}

/**
 * Every interrupted take in `recordingsDir`. A marker whose manifest exists after all (the
 * manifest write raced the crash) is not interrupted and is removed by the caller through
 * `forgetInterruptedTake`; one whose video is missing or empty is listed with `screenBytes: 0`
 * so the UI can offer to clean it up rather than to recover nothing.
 */
export async function scanInterruptedTakes(
	recordingsDir: string,
	io: ScanFs = nodeScanFs,
): Promise<InterruptedTake[]> {
	let entries: string[];
	try {
		entries = await io.readdir(recordingsDir);
	} catch {
		return [];
	}
	const found: InterruptedTake[] = [];
	for (const entry of entries) {
		if (!entry.endsWith(IN_PROGRESS_SUFFIX)) continue;
		const markerPath = path.join(recordingsDir, entry);
		let raw: string;
		try {
			raw = await io.readFile(markerPath);
		} catch {
			continue;
		}
		const marker = parseMarker(raw);
		if (!marker) continue;
		const manifest = await io.stat(sessionManifestPath(recordingsDir, marker.screenVideoPath));
		if (manifest) continue; // the take did finish; the marker is a leftover
		const screen = await io.stat(marker.screenVideoPath);
		const webcam = marker.webcamVideoPath ? await io.stat(marker.webcamVideoPath) : null;
		found.push({
			markerPath,
			marker,
			screenBytes: screen?.size ?? 0,
			webcamExists: webcam !== null && webcam.size > 0,
		});
	}
	return found.sort((a, b) => b.marker.recordingId - a.marker.recordingId);
}

/** The session a recovered take becomes: the marker's facts, flagged as recovered. */
export function sessionFromInterruptedTake(
	take: InterruptedTake,
	now = Date.now,
): RecordingSession {
	const stopAt = new Date(now()).toISOString();
	const events: RecordingEvent[] = [
		...take.marker.events,
		{
			type: "stop",
			atMs: lastRecordingTime(take.marker.events),
			wallClock: stopAt,
			recovered: true,
		},
	];
	return {
		screenVideoPath: take.marker.screenVideoPath,
		...(take.webcamExists && take.marker.webcamVideoPath
			? { webcamVideoPath: take.marker.webcamVideoPath }
			: {}),
		...(take.marker.cursorCaptureMode ? { cursorCaptureMode: take.marker.cursorCaptureMode } : {}),
		createdAt: take.marker.recordingId,
		events,
		recovered: true,
	};
}

function lastRecordingTime(events: RecordingEvent[]): number {
	return events.reduce((max, event) => Math.max(max, event.atMs), 0);
}

/** Writes the manifest for a recovered take and removes its marker. */
export async function recoverInterruptedTake(
	recordingsDir: string,
	take: InterruptedTake,
	io: TakeJournalFs = nodeFs,
	now = Date.now,
): Promise<RecordingSession> {
	const session = sessionFromInterruptedTake(take, now);
	const manifestPath = sessionManifestPath(recordingsDir, session.screenVideoPath);
	const tmp = `${manifestPath}.tmp-${process.pid}`;
	await io.writeFile(tmp, JSON.stringify(session, null, 2));
	await io.rename(tmp, manifestPath);
	await io.rm(take.markerPath);
	return session;
}

/** Removes a marker the user chose not to recover (the video is left where it is). */
export async function forgetInterruptedTake(
	take: InterruptedTake,
	io: TakeJournalFs = nodeFs,
): Promise<void> {
	await io.rm(take.markerPath);
}
