import { describe, expect, it } from "vitest";
import { countdownSecondsFrom, countdownValues } from "./countdown";

describe("countdown", () => {
	it("counts down from the chosen length and shows nothing for 0", () => {
		expect(countdownValues(3)).toEqual([3, 2, 1]);
		expect(countdownValues(5)).toEqual([5, 4, 3, 2, 1]);
		expect(countdownValues(10)).toHaveLength(10);
		expect(countdownValues(0)).toEqual([]);
	});

	it("reads only the offered lengths and defaults otherwise", () => {
		expect(countdownSecondsFrom(5)).toBe(5);
		expect(countdownSecondsFrom(0)).toBe(0);
		expect(countdownSecondsFrom(4)).toBe(3);
		expect(countdownSecondsFrom("3")).toBe(3);
		expect(countdownSecondsFrom(undefined)).toBe(3);
	});
});
