import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { watchDiskSpace } from "./diskSpaceWatch";

const MB = 1024 * 1024;

describe("watchDiskSpace", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	function start(sequence: number[], onLow = vi.fn(), onCritical = vi.fn()) {
		let i = 0;
		const watch = watchDiskSpace({
			dir: "/rec",
			onLow,
			onCritical,
			check: async () => ({ availableBytes: sequence[Math.min(i++, sequence.length - 1)] }),
			intervalMs: 1000,
			lowBytes: 500 * MB,
			criticalBytes: 100 * MB,
		});
		return { watch, onLow, onCritical };
	}

	it("says nothing while there is room", async () => {
		const { watch, onLow, onCritical } = start([900 * MB, 800 * MB]);
		await vi.advanceTimersByTimeAsync(2500);
		expect(onLow).not.toHaveBeenCalled();
		expect(onCritical).not.toHaveBeenCalled();
		watch.stop();
	});

	it("warns once when space runs low, then keeps watching", async () => {
		const { watch, onLow, onCritical } = start([400 * MB, 300 * MB, 200 * MB]);
		await vi.advanceTimersByTimeAsync(3500);
		expect(onLow).toHaveBeenCalledTimes(1);
		expect(onLow).toHaveBeenCalledWith(400 * MB);
		expect(onCritical).not.toHaveBeenCalled();
		watch.stop();
	});

	it("fires critical once and stops itself", async () => {
		const { onLow, onCritical } = start([300 * MB, 50 * MB, 10 * MB]);
		await vi.advanceTimersByTimeAsync(5000);
		expect(onLow).toHaveBeenCalledTimes(1);
		expect(onCritical).toHaveBeenCalledTimes(1);
		expect(onCritical).toHaveBeenCalledWith(50 * MB);
	});

	it("a failing check is not a full disk", async () => {
		const onCritical = vi.fn();
		const watch = watchDiskSpace({
			dir: "/rec",
			onLow: vi.fn(),
			onCritical,
			check: async () => {
				throw new Error("ENOSYS");
			},
			intervalMs: 1000,
		});
		await vi.advanceTimersByTimeAsync(3500);
		expect(onCritical).not.toHaveBeenCalled();
		watch.stop();
	});

	it("stop prevents later callbacks", async () => {
		const { watch, onLow } = start([10 * MB]);
		watch.stop();
		await vi.advanceTimersByTimeAsync(3000);
		expect(onLow).not.toHaveBeenCalled();
	});
});
