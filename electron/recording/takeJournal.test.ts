import { describe, expect, it } from "vitest";
import {
	forgetInterruptedTake,
	inProgressMarkerPath,
	recoverInterruptedTake,
	type ScanFs,
	scanInterruptedTakes,
	sessionFromInterruptedTake,
	TakeJournal,
	type TakeJournalFs,
} from "./takeJournal";

/** An in-memory filesystem shared by the journal and the scan. */
function memFs() {
	const files = new Map<string, string>();
	const io: TakeJournalFs & ScanFs = {
		writeFile: async (p, data) => void files.set(p, data),
		rm: async (p) => void files.delete(p),
		rename: async (from, to) => {
			const data = files.get(from);
			if (data === undefined) throw new Error(`ENOENT ${from}`);
			files.delete(from);
			files.set(to, data);
		},
		readdir: async (dir) =>
			[...files.keys()].filter((p) => p.startsWith(`${dir}/`)).map((p) => p.slice(dir.length + 1)),
		readFile: async (p) => {
			const data = files.get(p);
			if (data === undefined) throw new Error(`ENOENT ${p}`);
			return data;
		},
		stat: async (p) => (files.has(p) ? { size: files.get(p)?.length ?? 0 } : null),
	};
	return { files, io };
}

const DIR = "/rec";
const take = {
	recordingId: 1_700_000_000_000,
	backend: "windows-wgc" as const,
	recordingsDir: DIR,
	screenVideoPath: `${DIR}/recording-1700000000000.mp4`,
	webcamVideoPath: `${DIR}/recording-1700000000000-webcam.mp4`,
	cursorCaptureMode: "editable-overlay" as const,
};

function clock(start = 1_700_000_000_000) {
	let now = start;
	return {
		now: () => now,
		advance: (ms: number) => {
			now += ms;
		},
	};
}

describe("TakeJournal", () => {
	it("writes a marker at begin and removes it at finish", async () => {
		const { files, io } = memFs();
		const c = clock();
		const journal = new TakeJournal(io, c.now);
		await journal.begin(take);
		const markerPath = inProgressMarkerPath(DIR, take.screenVideoPath);
		expect(files.has(markerPath)).toBe(true);
		expect(JSON.parse(files.get(markerPath) ?? "")).toMatchObject({
			version: 1,
			recordingId: take.recordingId,
			backend: "windows-wgc",
			screenVideoPath: take.screenVideoPath,
			webcamVideoPath: take.webcamVideoPath,
			cursorCaptureMode: "editable-overlay",
			events: [{ type: "start", atMs: 0 }],
		});
		c.advance(5000);
		const summary = await journal.finish();
		expect(files.has(markerPath)).toBe(false);
		expect(summary?.durationMs).toBe(5000);
		expect(summary?.events.map((e) => e.type)).toEqual(["start", "stop"]);
		expect(journal.active).toBe(false);
	});

	it("keeps recording time still across a pause and records both clocks", async () => {
		const { io } = memFs();
		const c = clock();
		const journal = new TakeJournal(io, c.now);
		await journal.begin(take);
		c.advance(2000);
		await journal.pause();
		c.advance(3000); // paused for 3 s of wall-clock
		expect(journal.recordingTimeMs()).toBe(2000);
		await journal.resume();
		c.advance(1000);
		const summary = await journal.finish();
		expect(summary?.durationMs).toBe(3000);
		expect(summary?.pauseRanges).toEqual([{ startMs: 2000, endMs: 2000 }]);
		expect(summary?.events).toEqual([
			{ type: "start", atMs: 0, wallClock: "2023-11-14T22:13:20.000Z" },
			{ type: "pause", atMs: 2000, wallClock: "2023-11-14T22:13:22.000Z" },
			{ type: "resume", atMs: 2000, wallClock: "2023-11-14T22:13:25.000Z", pausedForMs: 3000 },
			{ type: "stop", atMs: 3000, wallClock: "2023-11-14T22:13:26.000Z" },
		]);
	});

	it("ignores a double pause or a resume while running", async () => {
		const { io } = memFs();
		const c = clock();
		const journal = new TakeJournal(io, c.now);
		await journal.begin(take);
		await journal.resume();
		await journal.pause();
		await journal.pause();
		const summary = await journal.finish();
		expect(summary?.events.map((e) => e.type)).toEqual(["start", "pause", "resume", "stop"]);
	});

	it("closes an open pause at finish so the stop lands on recording time", async () => {
		const { io } = memFs();
		const c = clock();
		const journal = new TakeJournal(io, c.now);
		await journal.begin(take);
		c.advance(1000);
		await journal.pause();
		c.advance(9000);
		const summary = await journal.finish();
		expect(summary?.durationMs).toBe(1000);
	});

	it("discard removes the marker and reports nothing", async () => {
		const { files, io } = memFs();
		const journal = new TakeJournal(io, clock().now);
		await journal.begin(take);
		await journal.discard();
		expect([...files.keys()].some((p) => p.endsWith(".inprogress.json"))).toBe(false);
		expect(await journal.finish()).toBeNull();
	});

	it("survives a filesystem that refuses the marker", async () => {
		const io: TakeJournalFs = {
			writeFile: async () => {
				throw new Error("EROFS");
			},
			rm: async () => undefined,
			rename: async () => undefined,
		};
		const journal = new TakeJournal(io, clock().now);
		await expect(journal.begin(take)).resolves.toBeUndefined();
		expect(journal.active).toBe(true);
	});
});

describe("scanInterruptedTakes", () => {
	it("lists a marker whose video exists and whose manifest does not", async () => {
		const { files, io } = memFs();
		const c = clock();
		const journal = new TakeJournal(io, c.now);
		await journal.begin(take);
		files.set(take.screenVideoPath, "x".repeat(4096));
		const found = await scanInterruptedTakes(DIR, io);
		expect(found).toHaveLength(1);
		expect(found[0].screenBytes).toBe(4096);
		expect(found[0].webcamExists).toBe(false);
		expect(found[0].marker.recordingId).toBe(take.recordingId);
	});

	it("skips a marker whose manifest was written after all", async () => {
		const { files, io } = memFs();
		const journal = new TakeJournal(io, clock().now);
		await journal.begin(take);
		files.set(take.screenVideoPath, "x");
		files.set(`${DIR}/recording-1700000000000.session.json`, "{}");
		expect(await scanInterruptedTakes(DIR, io)).toEqual([]);
	});

	it("reports a missing video as zero bytes rather than dropping the take", async () => {
		const { io } = memFs();
		const journal = new TakeJournal(io, clock().now);
		await journal.begin(take);
		const [found] = await scanInterruptedTakes(DIR, io);
		expect(found.screenBytes).toBe(0);
	});

	it("ignores unparseable markers and a missing directory", async () => {
		const { files, io } = memFs();
		files.set(`${DIR}/broken.inprogress.json`, "{not json");
		files.set(`${DIR}/old.inprogress.json`, JSON.stringify({ version: 99 }));
		expect(await scanInterruptedTakes(DIR, io)).toEqual([]);
		expect(await scanInterruptedTakes("/nowhere", io)).toEqual([]);
	});
});

describe("recoverInterruptedTake", () => {
	it("writes a recovered session manifest and removes the marker", async () => {
		const { files, io } = memFs();
		const c = clock();
		const journal = new TakeJournal(io, c.now);
		await journal.begin(take);
		c.advance(1500);
		await journal.pause();
		files.set(take.screenVideoPath, "video");
		files.set(take.webcamVideoPath, "cam");
		const [found] = await scanInterruptedTakes(DIR, io);
		c.advance(60_000);
		const session = await recoverInterruptedTake(DIR, found, io, c.now);
		expect(session).toMatchObject({
			screenVideoPath: take.screenVideoPath,
			webcamVideoPath: take.webcamVideoPath,
			cursorCaptureMode: "editable-overlay",
			createdAt: take.recordingId,
			recovered: true,
		});
		expect(session.events?.at(-1)).toMatchObject({ type: "stop", atMs: 1500, recovered: true });
		expect(files.has(`${DIR}/recording-1700000000000.session.json`)).toBe(true);
		expect(files.has(found.markerPath)).toBe(false);
	});

	it("leaves the webcam out when its file is missing", async () => {
		const { files, io } = memFs();
		const journal = new TakeJournal(io, clock().now);
		await journal.begin(take);
		files.set(take.screenVideoPath, "video");
		const [found] = await scanInterruptedTakes(DIR, io);
		expect(sessionFromInterruptedTake(found).webcamVideoPath).toBeUndefined();
	});

	it("forget removes only the marker", async () => {
		const { files, io } = memFs();
		const journal = new TakeJournal(io, clock().now);
		await journal.begin(take);
		files.set(take.screenVideoPath, "video");
		const [found] = await scanInterruptedTakes(DIR, io);
		await forgetInterruptedTake(found, io);
		expect(files.has(found.markerPath)).toBe(false);
		expect(files.has(take.screenVideoPath)).toBe(true);
	});
});
