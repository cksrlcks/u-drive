import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { UploadItem } from "@/features/upload/uploadQueue";
import { StorageError, type UploadTask } from "@/storage/StorageProvider";
import { runLink, type RunDeps } from "./runLink";
import type { Baseline, Scan, SyncLink } from "./type";

const NOW = 1_000_000;
const link: SyncLink = { id: "L", account: "a", libId: "lib", drivePath: "/기획안", localRoot: "C:/x", paused: false, fresh: false };
const f = (rel: string, mtime = NOW - 100) => ({ rel, path: `C:/x/${rel}`, size: 1, mtime });
const scanOf = (rels: string[], dirs: string[] = []): Scan => ({ files: rels.map((r) => f(r)), dirs, totalBytes: 0 });
const base = (rels: string[], dirs: string[] = []): Baseline => ({ files: Object.fromEntries(rels.map((r) => [r, { size: 1, mtime: NOW - 100 }])), dirs });

let tree: Map<string, "file" | "dir">;
let removeErr: Record<string, Error>;
let outcome: (t: UploadTask) => UploadItem["status"];
let added: UploadTask[];
let written: Baseline | undefined;
let writeBase: Mock<RunDeps["writeBase"]>;
let storage: { [K in keyof RunDeps["storage"]]: Mock<RunDeps["storage"][K]> };
let deps: RunDeps;

beforeEach(() => {
  tree = new Map([["/기획안", "dir"]]);
  removeErr = {};
  outcome = () => "done";
  added = [];
  written = undefined;
  storage = {
    listDir: vi.fn<RunDeps["storage"]["listDir"]>(async (_l: string, p: string) => {
      if (tree.get(p) !== "dir") throw new StorageError("notFound", "x");
      return [...tree]
        .filter(([k]) => k.startsWith(p + "/") && !k.slice(p.length + 1).includes("/"))
        .map(([k, type]) => ({ id: k, name: k.slice(p.length + 1), type, size: 0, mtime: 0, path: k }));
    }),
    mkdir: vi.fn<RunDeps["storage"]["mkdir"]>(async (_l: string, p: string) => void tree.set(p, "dir")),
    remove: vi.fn<RunDeps["storage"]["remove"]>(async (_l: string, p: string) => {
      if (removeErr[p]) throw removeErr[p];
      tree.delete(p);
    }),
  };
  writeBase = vi.fn<RunDeps["writeBase"]>(async (_id: string, b: Baseline) => void (written = b));
  const items: UploadItem[] = [];
  deps = {
    storage,
    uploads: {
      add: (libId: string, tasks: UploadTask[]) => {
        added.push(...tasks);
        return tasks.map((task) => {
          const id = String(items.length + 1);
          items.push({ id, task, libId, status: outcome(task), sent: 0, total: 0, attempts: 1 });
          return id;
        });
      },
      subscribe: () => () => {},
      getSnapshot: () => items,
    },
    scan: async () => scanOf([]),
    readBase: async () => null,
    writeBase,
    nowSec: () => NOW,
  };
});

describe("runLink", () => {
  it("local missing deletes nothing", async () => {
    const r = await runLink(link, { ...deps, scan: async () => "NOT_FOUND", readBase: async () => base(["a"]) });
    expect(r).toEqual({ status: "localMissing" });
    expect(storage.remove).not.toHaveBeenCalled();
    expect(writeBase).not.toHaveBeenCalled();
  });

  it("drive folder missing stops", async () => {
    tree.clear();
    expect(await runLink(link, { ...deps, readBase: async () => base(["a"]) })).toEqual({ status: "driveMissing" });
    expect(storage.remove).not.toHaveBeenCalled();
    expect(writeBase).not.toHaveBeenCalled();
  });

  it("rethrows non-notFound drive errors", async () => {
    storage.listDir.mockRejectedValue(new StorageError("unauthorized", "x", 401));
    await expect(runLink(link, deps)).rejects.toThrow();
    expect(writeBase).not.toHaveBeenCalled();
  });

  it("mass delete asks and changes nothing", async () => {
    const names = Array.from({ length: 10 }, (_, i) => `f${i}`);
    const r = await runLink(link, { ...deps, readBase: async () => base(names) });
    expect(r).toEqual({ status: "needsConfirm", deleteCount: 10 });
    expect(storage.remove).not.toHaveBeenCalled();
    expect(writeBase).not.toHaveBeenCalled();
  });

  it("confirmedDeletes lets mass delete through", async () => {
    const names = Array.from({ length: 10 }, (_, i) => `f${i}`);
    for (const n of names) tree.set(`/기획안/${n}`, "file");
    await runLink(link, { ...deps, readBase: async () => base(names) }, { confirmedDeletes: true });
    expect(storage.remove).toHaveBeenCalledTimes(10);
    expect(written!.files).toEqual({});
  });

  it("uploads with relativePath and records done files and parent dirs", async () => {
    const r = await runLink(link, { ...deps, scan: async () => scanOf(["a.docx", "sub/x/b.docx"], ["sub", "sub/x"]) });
    expect(r).toEqual({ status: "idle", deferred: 0 });
    expect(added.map((t) => [t.targetDir, t.relativePath])).toEqual([
      ["/기획안", undefined],
      ["/기획안", "sub/x"],
    ]);
    expect(added[1].file).toMatchObject({ name: "b.docx", localPath: "C:/x/sub/x/b.docx", lastModified: (NOW - 100) * 1000 });
    expect(Object.keys(written!.files)).toEqual(["a.docx", "sub/x/b.docx"]);
    expect([...written!.dirs].sort()).toEqual(["sub", "sub/x"]);
  });

  it("failed or cancelled upload stays out of baseline", async () => {
    outcome = (t) => (t.file.name === "a" ? "failed" : "cancelled");
    await runLink(link, { ...deps, scan: async () => scanOf(["a", "b"]) });
    expect(Object.keys(written!.files)).toEqual([]);
  });

  it("failed upload keeps old baseline entry so it retries", async () => {
    outcome = () => "failed";
    const s = scanOf(["a"]);
    s.files[0].mtime = NOW - 50;
    await runLink(link, { ...deps, scan: async () => s, readBase: async () => base(["a"]) });
    expect(written!.files.a.mtime).toBe(NOW - 100);
  });

  it("mkdir skips existing dir", async () => {
    tree.set("/기획안/빈폴더", "dir");
    await runLink(link, { ...deps, scan: async () => scanOf([], ["빈폴더"]) });
    expect(storage.mkdir).not.toHaveBeenCalled();
    expect(written!.dirs).toEqual(["빈폴더"]);
  });

  it("mkdir creates missing nested dirs in order", async () => {
    await runLink(link, { ...deps, scan: async () => scanOf([], ["a", "a/b"]) });
    expect(storage.mkdir.mock.calls.map((c) => c[1])).toEqual(["/기획안/a", "/기획안/a/b"]);
    expect(written!.dirs).toEqual(["a", "a/b"]);
  });

  it("removes baseline files and treats notFound as removed", async () => {
    removeErr["/기획안/b"] = new StorageError("notFound", "x");
    tree.set("/기획안/a", "file");
    await runLink(link, { ...deps, scan: async () => scanOf(["a"]), readBase: async () => base(["a", "b"]) });
    expect(storage.remove).toHaveBeenCalledWith("lib", "/기획안/b", "file");
    expect(written!.files).not.toHaveProperty("b");
  });

  it("other remove errors keep the entry; unauthorized rethrows after saving", async () => {
    removeErr["/기획안/b"] = new StorageError("server", "x");
    await runLink(link, { ...deps, readBase: async () => base(["b"]) });
    expect(written!.files).toHaveProperty("b");
    removeErr["/기획안/b"] = new StorageError("unauthorized", "x", 401);
    written = undefined;
    await expect(runLink(link, { ...deps, readBase: async () => base(["b"]) })).rejects.toThrow();
    expect(written!.files).toHaveProperty("b");
  });

  it("removeDirs keeps non-empty drive dir", async () => {
    tree.set("/기획안/d", "dir");
    tree.set("/기획안/d/x.pdf", "file");
    await runLink(link, { ...deps, readBase: async () => base([], ["d"]) });
    expect(storage.remove).not.toHaveBeenCalledWith("lib", "/기획안/d", "dir");
    expect(written!.dirs).toEqual([]);
  });

  it("removeDirs removes empty drive dir", async () => {
    tree.set("/기획안/d", "dir");
    await runLink(link, { ...deps, readBase: async () => base([], ["d"]) });
    expect(storage.remove).toHaveBeenCalledWith("lib", "/기획안/d", "dir");
    expect(written!.dirs).toEqual([]);
  });

  it("fresh link uploads everything and removes nothing", async () => {
    tree.set("/기획안/old.pdf", "file");
    const r = await runLink({ ...link, fresh: true }, { ...deps, scan: async () => scanOf(["a"]) });
    expect(storage.remove).not.toHaveBeenCalled();
    expect(r).toEqual({ status: "idle", deferred: 0 });
    expect(added).toHaveLength(1);
  });

  it("deferred count is returned", async () => {
    const s = scanOf(["a"]);
    s.files[0].mtime = NOW - 1;
    expect(await runLink(link, { ...deps, scan: async () => s })).toEqual({ status: "idle", deferred: 1 });
    expect(added).toHaveLength(0);
  });
});
