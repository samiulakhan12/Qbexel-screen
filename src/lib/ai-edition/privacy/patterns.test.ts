import { describe, expect, it } from "vitest";
import { findSensitiveText, ibanValid, luhnValid, maskValue, shannonEntropy } from "./patterns";

const kinds = (text: string) => findSensitiveText(text).map((m) => m.kind);

describe("findSensitiveText", () => {
	it("finds keys with known prefixes and masks them", () => {
		const matches = findSensitiveText("API key sk-live-4f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c here");
		expect(matches).toHaveLength(1);
		expect(matches[0].kind).toBe("api-key");
		expect(matches[0].preview).toBe("sk-••••••••••••b5c");
		expect(matches[0].preview).not.toContain("4f9a8b7c");
		expect(text(matches[0], "API key sk-live-4f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c here")).toBe(
			"sk-live-4f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c",
		);
		expect(kinds("AKIAIOSFODNN7EXAMPLE")).toEqual(["api-key"]);
		expect(kinds("ghp_abcdefghijklmnopqrstuvwxyz0123456789")).toEqual(["api-key"]);
		expect(kinds("xoxb-1234567890-abcdefghij")).toEqual(["api-key"]);
	});

	it("finds JWTs, bearer tokens and secret assignments", () => {
		expect(
			kinds(
				"Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
			),
		).toEqual(["token"]);
		expect(kinds("Bearer abcdefghijklmnopqrstuvwxyz0123")).toEqual(["token"]);
		const assignment = findSensitiveText('password = "hunter2hunter2"');
		expect(assignment).toHaveLength(1);
		expect(assignment[0].kind).toBe("secret-assignment");
		expect(assignment[0].preview).toBe("hun••••••••er2");
		expect(kinds("API_KEY: abc123def456")).toEqual(["secret-assignment"]);
	});

	it("finds emails, card numbers that pass Luhn, valid IBANs and credential URLs", () => {
		const email = findSensitiveText("Contact jane.doe@example.com for help");
		expect(email[0].kind).toBe("email");
		expect(email[0].preview).toBe("j••••••e@example.com");
		expect(kinds("card 4111 1111 1111 1111 exp 12/27")).toEqual(["card"]);
		expect(kinds("card 4111 1111 1111 1112")).toEqual([]);
		expect(kinds("IBAN GB82 WEST 1234 5698 7654 32")).toEqual(["iban"]);
		expect(kinds("IBAN GB82 WEST 1234 5698 7654 33")).toEqual([]);
		const url = findSensitiveText("postgres at https://admin:s3cretpass@db.example.com/app");
		expect(url[0].kind).toBe("url-credential");
		expect(url[0].preview).toContain("admin:•••@");
		expect(kinds("-----BEGIN RSA PRIVATE KEY-----")).toEqual(["private-key"]);
	});

	it("takes phones only with a plausible shape and separators", () => {
		expect(kinds("Call +1 415 555 0133 today")).toEqual(["phone"]);
		expect(kinds("ring 020 7946 0958 now")).toEqual(["phone"]);
		expect(kinds("order 123456789")).toEqual([]);
		expect(kinds("version 2.4.11")).toEqual([]);
		expect(kinds("in 2024 we had 1200 users")).toEqual([]);
	});

	it("rates IP addresses low, private ranges lower, and skips loopback", () => {
		const pub = findSensitiveText("server 203.0.113.42 is up");
		expect(pub[0].kind).toBe("ip");
		expect(pub[0].preview).toBe("203.0.•.•");
		const priv = findSensitiveText("router 192.168.1.1");
		expect(priv[0].confidence).toBeLessThan(pub[0].confidence);
		expect(kinds("listening on 127.0.0.1")).toEqual([]);
		expect(kinds("version 10.0.0")).toEqual([]);
	});

	it("takes a long high-entropy run as a key but not a word or a path", () => {
		expect(kinds("token Zq9xK2mP8vL4nR7tY1wE3uI6oA5sD0fG")).toEqual(["api-key"]);
		expect(kinds("supercalifragilisticexpialidociousness")).toEqual([]);
		expect(kinds("/usr/local/lib/node_modules/typescript/lib/tsc.js")).toEqual([]);
		const hash = findSensitiveText("sha 9e107d9d372bb6826bd81d3542a419d6a1b2c3d4");
		expect(hash[0]?.kind).toBe("api-key");
		expect(hash[0]?.confidence).toBeLessThan(0.5);
	});

	it("keeps one finding where two detectors overlap, the stronger one", () => {
		const matches = findSensitiveText("secret = sk-live-4f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c");
		expect(matches).toHaveLength(1);
		expect(matches[0].kind).toBe("api-key");
	});

	it("returns nothing for ordinary tutorial text", () => {
		expect(
			findSensitiveText(
				"Welcome to the billing settings. Click the yearly plan, then save. Your invoice appears on the right.",
			),
		).toEqual([]);
	});
});

function text(match: { start: number; end: number }, source: string): string {
	return source.slice(match.start, match.end);
}

describe("helpers", () => {
	it("masks values keeping their edges", () => {
		expect(maskValue("abcdefghij", 2)).toBe("ab••••••ij");
		expect(maskValue("abc", 2)).toBe("•••");
		expect(maskValue("a".repeat(40), 2).length).toBe(16);
	});

	it("validates Luhn and IBAN checksums", () => {
		expect(luhnValid("4111111111111111")).toBe(true);
		expect(luhnValid("4111111111111112")).toBe(false);
		expect(luhnValid("12")).toBe(false);
		expect(ibanValid("DE89 3704 0044 0532 0130 00")).toBe(true);
		expect(ibanValid("DE89 3704 0044 0532 0130 01")).toBe(false);
	});

	it("measures entropy", () => {
		expect(shannonEntropy("aaaa")).toBe(0);
		expect(shannonEntropy("abcd")).toBe(2);
		expect(shannonEntropy("Zq9xK2mP8vL4nR7tY1wE3uI6oA5sD0fG")).toBeGreaterThan(4.2);
	});
});
