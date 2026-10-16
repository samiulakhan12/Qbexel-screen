// What sensitive text looks like, and how to say it without repeating it.
//
// Pure. Runs over any text — a line OCR'd off a frame, the words of the transcript —
// and returns matches with their kind, a confidence and a MASKED preview. The value
// itself never leaves this function: the review stores the preview, the blur covers
// the picture, and nothing downstream has the secret to leak.
//
// Precision over recall where the two conflict: a card number has to pass Luhn, an
// IBAN its checksum, a phone needs a plausible shape, and a bare long alphanumeric run
// counts as a key only when its entropy says it is not a word. OCR text is noisy, so
// every matcher is tolerant of the usual confusions where that does not cost precision.

import type { AxcutPrivacyFindingKind } from "../schema";

export interface PatternMatch {
	kind: AxcutPrivacyFindingKind;
	/** Character offsets into the scanned text, end exclusive. */
	start: number;
	end: number;
	preview: string;
	confidence: number;
}

/** Mask all but the edges: enough to recognise the finding, not enough to reuse it. */
export function maskValue(value: string, keep = 2): string {
	const trimmed = value.trim();
	if (trimmed.length <= keep * 2 + 1) return "•".repeat(Math.max(3, trimmed.length));
	const hidden = Math.min(12, trimmed.length - keep * 2);
	return `${trimmed.slice(0, keep)}${"•".repeat(hidden)}${trimmed.slice(-keep)}`;
}

/** Shannon entropy in bits per character. English words sit near 3, random keys near 4.5+. */
export function shannonEntropy(text: string): number {
	if (!text) return 0;
	const counts = new Map<string, number>();
	for (const ch of text) counts.set(ch, (counts.get(ch) ?? 0) + 1);
	let entropy = 0;
	for (const count of counts.values()) {
		const p = count / text.length;
		entropy -= p * Math.log2(p);
	}
	return entropy;
}

export function luhnValid(digits: string): boolean {
	if (!/^\d{12,19}$/.test(digits)) return false;
	let sum = 0;
	let double = false;
	for (let i = digits.length - 1; i >= 0; i--) {
		let d = Number(digits[i]);
		if (double) {
			d *= 2;
			if (d > 9) d -= 9;
		}
		sum += d;
		double = !double;
	}
	return sum % 10 === 0;
}

export function ibanValid(candidate: string): boolean {
	const iban = candidate.replace(/\s+/g, "").toUpperCase();
	if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
	const rearranged = iban.slice(4) + iban.slice(0, 4);
	let remainder = 0;
	for (const ch of rearranged) {
		const value = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
		for (const digit of value) remainder = (remainder * 10 + Number(digit)) % 97;
	}
	return remainder === 1;
}

interface Detector {
	kind: AxcutPrivacyFindingKind;
	pattern: RegExp;
	confidence: number;
	/** Narrow the regex: return false to drop a match, or a replacement confidence. */
	accept?: (match: RegExpExecArray) => boolean | number;
	/** Which capture carries the value to mask; the whole match when omitted. */
	valueGroup?: number;
}

const DETECTORS: Detector[] = [
	{
		kind: "private-key",
		pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
		confidence: 0.98,
	},
	{
		kind: "url-credential",
		pattern: /\bhttps?:\/\/[^\s/:@]+:([^\s/@]{3,})@[^\s/]+/gi,
		confidence: 0.95,
	},
	{
		// Known prefixes: OpenAI, Anthropic, AWS, GitHub, Slack, Google, Stripe, generic
		// "sk-live-…" style publishable/secret keys.
		kind: "api-key",
		pattern:
			/\b(sk-(?:ant-|live-|test-|proj-)?[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|(?:pk|rk)_(?:live|test)_[A-Za-z0-9]{16,})\b/g,
		confidence: 0.95,
	},
	{
		kind: "token",
		pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
		confidence: 0.95,
	},
	{
		kind: "token",
		pattern: /\b(?:Bearer|bearer)\s+([A-Za-z0-9._~+/=-]{20,})/g,
		confidence: 0.85,
		valueGroup: 1,
	},
	{
		kind: "secret-assignment",
		pattern:
			/\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key)\b\s*[:=]\s*["']?([^\s"']{6,})/gi,
		confidence: 0.8,
		valueGroup: 1,
	},
	{
		kind: "email",
		pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
		confidence: 0.9,
	},
	{
		kind: "iban",
		pattern: /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){2,7}(?:\s?[A-Z0-9]{1,4})?\b/g,
		confidence: 0.9,
		accept: (m) => ibanValid(m[0]),
	},
	{
		kind: "card",
		pattern: /\b(?:\d[ -]?){12,18}\d\b/g,
		confidence: 0.85,
		accept: (m) => luhnValid(m[0].replace(/[ -]/g, "")),
	},
	{
		kind: "phone",
		// International or national shapes with separators; 9 to 15 digits in all.
		// The lookarounds also refuse a match that is part of a longer digit run (a card
		// number's groups), which would otherwise read as a phone.
		pattern:
			/(?<![\w.]|\d[ .-])(?:\+\d{1,3}[ .-]?)?(?:\(\d{2,4}\)[ .-]?)?\d{2,4}(?:[ .-]\d{2,4}){2,4}(?![\w.]|[ .-]\d)/g,
		confidence: 0.6,
		accept: (m) => {
			const digits = m[0].replace(/\D/g, "");
			if (digits.length < 9 || digits.length > 15) return false;
			// Three or more four-digit groups ending in a one- or two-digit tail is an account
			// number's shape (an IBAN's groups), not a phone's.
			const groups = m[0]
				.replace(/^\+\d{1,3}[ .-]?/, "")
				.split(/[ .-]+/)
				.filter(Boolean)
				.map((group) => group.replace(/\D/g, "").length);
			const fourDigitGroups = groups.filter((length) => length === 4).length;
			if (fourDigitGroups >= 3 && groups[groups.length - 1] <= 2) return false;
			// A bare run of digits with a single separator reads as a number, not a phone.
			const separators = (m[0].match(/[ .()-]/g) ?? []).length;
			if (separators < 2) return false;
			return m[0].startsWith("+") ? 0.75 : 0.6;
		},
	},
	{
		kind: "ip",
		pattern: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g,
		confidence: 0.55,
		accept: (m) => {
			// Version-like strings and the loopback are not addresses worth hiding.
			if (m[0] === "127.0.0.1" || m[0] === "0.0.0.0") return false;
			const parts = m[0].split(".").map(Number);
			if (
				parts[0] === 10 ||
				(parts[0] === 192 && parts[1] === 168) ||
				(parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
			) {
				return 0.4;
			}
			return true;
		},
	},
	{
		// A long run of key-like characters with no known prefix: only when its entropy
		// says it is not a word, a path or a hash of something harmless we cannot tell apart.
		kind: "api-key",
		pattern: /(?<![\w/.-])[A-Za-z0-9_-]{32,}(?![\w/.-])/g,
		confidence: 0.6,
		accept: (m) => {
			const value = m[0];
			if (!/\d/.test(value) || !/[A-Za-z]/.test(value)) return false;
			if (/^[0-9a-f]{32,}$/i.test(value)) return 0.45; // a hash: shown, low confidence
			return shannonEntropy(value) >= 4.2;
		},
	},
];

function overlaps(a: PatternMatch, b: { start: number; end: number }): boolean {
	return a.start < b.end && b.start < a.end;
}

/** Every sensitive-looking span of `text`, highest-confidence first where spans overlap. */
export function findSensitiveText(text: string): PatternMatch[] {
	const matches: PatternMatch[] = [];
	for (const detector of DETECTORS) {
		detector.pattern.lastIndex = 0;
		for (let m = detector.pattern.exec(text); m; m = detector.pattern.exec(text)) {
			if (m[0].length === 0) {
				detector.pattern.lastIndex += 1;
				continue;
			}
			const verdict = detector.accept ? detector.accept(m) : true;
			if (verdict === false) continue;
			const confidence = typeof verdict === "number" ? verdict : detector.confidence;
			const value = detector.valueGroup !== undefined ? (m[detector.valueGroup] ?? m[0]) : m[0];
			const valueStart =
				detector.valueGroup !== undefined ? m.index + m[0].lastIndexOf(value) : m.index;
			const candidate: PatternMatch = {
				kind: detector.kind,
				start: detector.valueGroup !== undefined ? m.index : valueStart,
				end: m.index + m[0].length,
				preview: previewFor(detector.kind, value),
				confidence,
			};
			// Keep the stronger of two detectors claiming the same span (a key inside a
			// `secret = …` assignment is one finding, the assignment's).
			const clash = matches.findIndex((existing) => overlaps(existing, candidate));
			if (clash >= 0) {
				if (matches[clash].confidence >= candidate.confidence) continue;
				matches.splice(clash, 1);
			}
			matches.push(candidate);
		}
	}
	return matches.sort((a, b) => a.start - b.start);
}

function previewFor(kind: AxcutPrivacyFindingKind, value: string): string {
	switch (kind) {
		case "email": {
			const [user, domain] = value.split("@");
			return `${maskValue(user ?? "", 1)}@${domain ?? ""}`;
		}
		case "private-key":
			return "-----BEGIN PRIVATE KEY-----";
		case "url-credential":
			return value.replace(/:\/\/([^:]+):[^@]+@/, "://$1:•••@");
		case "card":
			return `•••• ${value.replace(/\D/g, "").slice(-4)}`;
		case "iban":
			return `${value.replace(/\s+/g, "").slice(0, 4)} •••• ${value.replace(/\s+/g, "").slice(-4)}`;
		case "ip":
			return value.replace(/\.\d+\.\d+$/, ".•.•");
		default:
			return maskValue(value, 3);
	}
}

/** True when a finding of this kind can be covered on the picture (all can; spoken ones cannot). */
export const FINDING_KINDS: readonly AxcutPrivacyFindingKind[] = [
	"api-key",
	"token",
	"private-key",
	"secret-assignment",
	"url-credential",
	"email",
	"phone",
	"card",
	"iban",
	"ip",
];
