import { describe, expect, it } from "vitest";
import {
	type BackupFs,
	backupFileName,
	listBackups,
	parseBackupTime,
	rotateBackup,
} from "./project-backups";

function memFs(files: Record<string, number>) {
	const io: BackupFs & { files: Record<string, number> } = {
		files,
		copyFile: async (from, to) => {
			files[to] = files[from];
		},
		mkdir: async () => undefined,
		readdir: async (dir) =>
			Object.keys(files)
				.filter((p) => p.startsWith(`${dir}/`))
				.map((p) => p.slice(dir.length + 1)),
		rm: async (p) => {
			delete files[p];
		},
		stat: async (p) => (p in files ? { mtimeMs: files[p] } : null),
	};
	return io;
}

const T0 = Date.UTC(2026, 9, 16, 12, 0, 0);

describe("backup names", () => {
	it("round-trip a timestamp without characters Windows rejects", () => {
		const name = backupFileName(T0 + 123, ".openscreen");
		expect(name).toBe("2026-10-16T12-00-00-123Z.openscreen");
		expect(name).not.toContain(":");
		expect(parseBackupTime(name)).toBe(T0 + 123);
		expect(parseBackupTime("junk.openscreen")).toBeNull();
	});
});

describe("rotateBackup", () => {
	it("copies the current file before a save and nothing for a new project", async () => {
		const io = memFs({ "/p/a.openscreen": 1 });
		const result = await rotateBackup("/p/a.openscreen", "/p/backups/a", { io, now: () => T0 });
		expect(result.written).toBe(`/p/backups/a/${backupFileName(T0, ".openscreen")}`);
		expect(Object.keys(io.files)).toHaveLength(2);
		const fresh = await rotateBackup("/p/new.openscreen", "/p/backups/new", { io, now: () => T0 });
		expect(fresh.written).toBeNull();
	});

	it("takes at most one copy per interval", async () => {
		const io = memFs({ "/p/a.openscreen": 1 });
		await rotateBackup("/p/a.openscreen", "/p/backups/a", { io, now: () => T0 });
		const again = await rotateBackup("/p/a.openscreen", "/p/backups/a", {
			io,
			now: () => T0 + 30_000,
		});
		expect(again.written).toBeNull();
		const later = await rotateBackup("/p/a.openscreen", "/p/backups/a", {
			io,
			now: () => T0 + 61_000,
		});
		expect(later.written).not.toBeNull();
	});

	it("prunes to the newest `keep` copies", async () => {
		const io = memFs({ "/p/a.openscreen": 1 });
		for (let i = 0; i < 5; i++) {
			await rotateBackup("/p/a.openscreen", "/p/backups/a", {
				io,
				keep: 3,
				now: () => T0 + i * 120_000,
			});
		}
		const backups = await listBackups("/p/backups/a", ".openscreen", io);
		expect(backups).toHaveLength(3);
		expect(backups[0].atMs).toBe(T0 + 4 * 120_000);
		expect(backups[2].atMs).toBe(T0 + 2 * 120_000);
	});

	it("never throws when the filesystem refuses", async () => {
		const io = memFs({ "/p/a.openscreen": 1 });
		io.copyFile = async () => {
			throw new Error("EACCES");
		};
		await expect(rotateBackup("/p/a.openscreen", "/p/backups/a", { io })).resolves.toEqual({
			written: null,
			pruned: [],
		});
	});
});
