// Free-space watch for a take in progress.
//
// `diskSpaceCheck.ts` looks once, before capture starts. A long take can still fill the disk,
// and the helpers then fail on a write with a raw error, after the user has spent the time.
// This watch polls the recordings volume while a take runs and raises two signals: `low`, once,
// so the HUD can warn while there is still room to stop cleanly; and `critical`, once, after
// which the caller stops the take so what was captured is kept.
//
// Pure: the check, the timers and the thresholds are injected; the tests drive them.

import { checkDiskSpace, LOW_DISK_SPACE_THRESHOLD_BYTES } from "./diskSpaceCheck";

/** Below this the take is stopped: a fragmented MP4 needs a little room to close. */
export const CRITICAL_DISK_SPACE_THRESHOLD_BYTES = 100 * 1024 * 1024;
export const DISK_SPACE_WATCH_INTERVAL_MS = 10_000;

export type DiskSpaceLevel = "low" | "critical";

export interface DiskSpaceWatchOptions {
	dir: string;
	onLow: (availableBytes: number) => void;
	onCritical: (availableBytes: number) => void;
	check?: (dir: string) => Promise<{ availableBytes: number }>;
	intervalMs?: number;
	lowBytes?: number;
	criticalBytes?: number;
	setInterval?: typeof globalThis.setInterval;
	clearInterval?: typeof globalThis.clearInterval;
}

export interface DiskSpaceWatch {
	/** Runs one check now; the timer calls this too. Resolves once callbacks have fired. */
	tick(): Promise<void>;
	stop(): void;
}

export function watchDiskSpace(options: DiskSpaceWatchOptions): DiskSpaceWatch {
	const check = options.check ?? checkDiskSpace;
	const lowBytes = options.lowBytes ?? LOW_DISK_SPACE_THRESHOLD_BYTES;
	const criticalBytes = options.criticalBytes ?? CRITICAL_DISK_SPACE_THRESHOLD_BYTES;
	const set = options.setInterval ?? globalThis.setInterval;
	const clear = options.clearInterval ?? globalThis.clearInterval;
	let warned = false;
	let stopped = false;
	let inFlight = false;

	const tick = async () => {
		if (stopped || inFlight) return;
		inFlight = true;
		try {
			const { availableBytes } = await check(options.dir);
			if (stopped) return;
			if (availableBytes < criticalBytes) {
				stop();
				options.onCritical(availableBytes);
				return;
			}
			if (availableBytes < lowBytes && !warned) {
				warned = true;
				options.onLow(availableBytes);
			}
		} catch {
			// A failed statfs is not a full disk: say nothing and look again next tick.
		} finally {
			inFlight = false;
		}
	};

	const timer = set(() => void tick(), options.intervalMs ?? DISK_SPACE_WATCH_INTERVAL_MS);

	function stop() {
		if (stopped) return;
		stopped = true;
		clear(timer);
	}

	return { tick, stop };
}
