// The pre-roll countdown's length, a recording preference.
//
// Shared by the main process (which validates the stored value) and the HUD (which counts).
// Import-free on purpose, like projectDefaults.

export const COUNTDOWN_SECONDS = [0, 3, 5, 10] as const;
export type CountdownSeconds = (typeof COUNTDOWN_SECONDS)[number];
export const DEFAULT_COUNTDOWN_SECONDS: CountdownSeconds = 3;

export function isCountdownSeconds(value: unknown): value is CountdownSeconds {
	return (COUNTDOWN_SECONDS as readonly number[]).includes(value as number);
}

/** The stored value, or the default for anything that is not one of the offered lengths. */
export function countdownSecondsFrom(value: unknown): CountdownSeconds {
	return isCountdownSeconds(value) ? value : DEFAULT_COUNTDOWN_SECONDS;
}

/** What the overlay shows, first to last: `[3, 2, 1]`; nothing at all for 0. */
export function countdownValues(seconds: CountdownSeconds): number[] {
	const values: number[] = [];
	for (let value = seconds; value >= 1; value -= 1) values.push(value);
	return values;
}
