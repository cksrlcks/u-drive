import { describe, expect, it, vi } from "vitest";
import { DownloadQueue } from "@/features/download/downloadQueue";
import { UploadQueue } from "@/features/upload/uploadQueue";
import { MockProvider } from "@/storage/mock/MockProvider";
import { callTool, normalizeDir, resolveTarget, type ToolCtx, type ToolResult } from "./tools";

function makeCtx(over: Partial<ToolCtx> = {}): ToolCtx {
  const storage = new MockProvider("t");
  return {
    storage,
    uploads: new UploadQueue(storage),
    downloads: new DownloadQueue(async () => {}),
    searchIndex: async () => [],
    readLocalFile: async (p) => new File(["x"], p.split(/[\\/]/).pop()!),
    freePath: async (d, n) => `${d}/${n}`,
    defaultDownloadDir: async () => "C:/Downloads",
    workDir: async () => "C:/Downloads/U-Drive 작업",
    recentFiles: async () => [],
    writeLocalFile: async () => {},
    realPath: async (p) => p,
    ...over,
  };
}
/** 첫 결과의 텍스트 */
const txt = (r: ToolResult) => (r.content[0] as { text: string }).text;
const parse = (r: ToolResult) => JSON.parse(txt(r));
const SLOW = 10_000; // MockProvider 업로드는 약 2초

describe("normalizeDir", () => {
  it("normalizes slashes", () => {
    expect(normalizeDir("피드백/2026-10/")).toBe("/피드백/2026-10");
    expect(normalizeDir("/피드백//2026-10")).toBe("/피드백/2026-10");
    expect(normalizeDir("")).toBe("/");
    expect(normalizeDir("/")).toBe("/");
  });
});

describe("resolveTarget", () => {
  it("splits missing Korean folders", async () => {
    expect(await resolveTarget(new MockProvider("t"), "docs", "/피드백/2026 10월")).toEqual({ targetDir: "/", relativePath: "피드백/2026 10월", existing: [] });
  });
  it("uses an existing folder as is", async () => {
    const r = await resolveTarget(new MockProvider("t"), "docs", "/회의록");
    expect(r.targetDir).toBe("/회의록");
    expect(r.relativePath).toBeUndefined();
    expect(r.existing).toHaveLength(2);
  });
});

describe("callTool", () => {
  it("list_libraries returns only my libraries unless scope is all", async () => {
    const mine = parse(await callTool("list_libraries", {}, makeCtx()));
    expect(mine.map((l: { id: string }) => l.id)).toEqual(["docs", "photos", "vault"]);
    const all = parse(await callTool("list_libraries", { scope: "all" }, makeCtx()));
    expect(all).toContainEqual({ id: "family", name: "집-공유", section: "나에게 공유됨", readOnly: true, encrypted: false });
  });

  it("list_dir lists entries with readable size and date", async () => {
    const r = parse(await callTool("list_dir", { library: "docs", path: "회의록" }, makeCtx()));
    expect(r.map((e: { name: string }) => e.name)).toEqual(["2026-10-20.md", "2026-10-13.md"]);
    expect(r[0].size).toMatch(/ (B|KB|MB)$/);
    expect(r[0].modified).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d$/);
    const root = parse(await callTool("list_dir", { library: "docs", path: "/" }, makeCtx()));
    expect(root.find((e: { name: string }) => e.name === "회의록").size).toBeUndefined();
  });

  it("list_dir without library uses the only '내 저장소' library, else lists candidates", async () => {
    const ctx = makeCtx();
    const many = await callTool("list_dir", { path: "/" }, ctx);
    expect(many.isError).toBe(true);
    expect(txt(many)).toContain('"id":"docs"');
    expect(txt(many)).not.toContain("vault"); // 암호화 저장소는 후보에서 뺀다
    const all = await ctx.storage.listLibraries();
    vi.spyOn(ctx.storage, "listLibraries").mockResolvedValue(all.filter((l) => l.id !== "photos"));
    const one = parse(await callTool("list_dir", { path: "회의록" }, ctx));
    expect(one.map((e: { name: string }) => e.name)).toEqual(["2026-10-20.md", "2026-10-13.md"]);
  });

  it(
    "upload_text creates folders and uploads",
    async () => {
      const ctx = makeCtx();
      const r = parse(await callTool("upload_text", { name: "계획.md", content: "# 안녕", library: "docs", dir: "피드백/2026-10/" }, ctx));
      expect(r.uploaded).toEqual([{ name: "계획.md", path: "/피드백/2026-10/계획.md" }]);
      expect((await ctx.storage.listDir("docs", "/피드백/2026-10")).map((e) => e.name)).toEqual(["계획.md"]);
    },
    SLOW,
  );

  // "hello"
  const HELLO = { base64: "aGVs\nbG8=", sha256: "2CF24DBA5FB0A30E26E83B2AC5B9E29E1B161E5C1FA7425E73043362938B9824" };

  it(
    "upload_base64 saves to the download folder first, then uploads",
    async () => {
      const saved: [string, number][] = [];
      const ctx = makeCtx({ writeLocalFile: async (p, d) => void saved.push([p, d.length]) });
      const r = parse(await callTool("upload_base64", { name: "보고서.docx", ...HELLO, library: "docs", dir: "/보고" }, ctx));
      expect(saved).toEqual([["C:/Downloads/보고서.docx", 5]]);
      expect(r.savedTo).toBe("C:/Downloads/보고서.docx");
      expect(r.uploaded).toEqual([{ name: "보고서.docx", path: "/보고/보고서.docx" }]);
      expect((await ctx.storage.listDir("docs", "/보고")).map((e) => [e.name, e.size])).toEqual([["보고서.docx", 5]]);
    },
    SLOW,
  );

  it("upload_base64 saves nothing when sha256 does not match or the name conflicts", async () => {
    const saved: string[] = [];
    const ctx = makeCtx({ writeLocalFile: async (p) => void saved.push(p) });
    const bad = await callTool("upload_base64", { name: "a.docx", base64: HELLO.base64, sha256: "00", library: "docs", dir: "/보고" }, ctx);
    expect(bad.isError).toBe(true);
    expect(txt(bad)).toContain("sha256");
    expect((await ctx.storage.listDir("docs", "/")).some((e) => e.name === "보고")).toBe(false);
    const conflict = parse(await callTool("upload_base64", { name: "README.md", ...HELLO, library: "docs", dir: "/" }, ctx));
    expect(conflict).toMatchObject({ uploaded: [], conflicts: ["README.md"] });
    expect(saved).toEqual([]);
  });

  it("upload_file refuses hidden and system paths, including through a link", async () => {
    const secret = await callTool("upload_file", { local_paths: ["/Users/kim/.ssh/id_rsa"], library: "docs", dir: "/" }, makeCtx());
    expect(secret.isError).toBe(true);
    expect(txt(secret)).toContain("숨김");
    const linked = makeCtx({ realPath: async (p) => (p === "/Users/kim/work/key" ? "/Users/kim/.ssh/id_rsa" : p) });
    const viaLink = await callTool("upload_file", { local_paths: ["/Users/kim/work/key"], library: "docs", dir: "/" }, linked);
    expect(viaLink.isError).toBe(true);
  });

  it("download refuses to write into startup folders", async () => {
    const r = await callTool("download", { library: "docs", paths: ["/README.md"], local_dir: "/Users/kim/Library/LaunchAgents" }, makeCtx());
    expect(r.isError).toBe(true);
    expect(txt(r)).toContain("설정");
  });

  it("upload_base64 keeps only the file name", async () => {
    const saved: string[] = [];
    const ctx = makeCtx({ writeLocalFile: async (p) => void saved.push(p) });
    await callTool("upload_base64", { name: "../../Library/LaunchAgents/x.plist", ...HELLO, library: "docs", dir: "/보고" }, ctx);
    expect(saved).toEqual(["C:/Downloads/x.plist"]);
  });

  it("upload_file stops entirely on any conflict", async () => {
    const ctx = makeCtx();
    const r = await callTool("upload_file", { local_paths: [String.raw`C:\x\README.md`, String.raw`C:\x\새 문서.md`], library: "docs", dir: "/" }, ctx);
    expect(r.isError).toBeFalsy();
    expect(parse(r)).toMatchObject({ uploaded: [], conflicts: ["README.md"] });
    expect((await ctx.storage.listDir("docs", "/")).some((e) => e.name === "새 문서.md")).toBe(false);
  });

  it(
    "upload_file overwrites when overwrite: true",
    async () => {
      const r = parse(await callTool("upload_file", { local_paths: [String.raw`C:\x\README.md`], library: "docs", dir: "/", overwrite: true }, makeCtx()));
      expect(r.uploaded).toEqual([{ name: "README.md", path: "/README.md" }]);
      expect(r.failed).toEqual([]);
    },
    SLOW,
  );

  it("rejects read-only and encrypted libraries", async () => {
    const ro = await callTool("upload_text", { name: "a.md", content: "a", library: "family", dir: "/" }, makeCtx());
    expect(ro.isError).toBe(true);
    expect(txt(ro)).toContain("읽기 전용");
    const enc = await callTool("download", { library: "vault", paths: ["/a"] }, makeCtx());
    expect(enc.isError).toBe(true);
    expect(txt(enc)).toContain("암호화");
  });

  it("download refuses folders and returns saved paths", async () => {
    const folder = await callTool("download", { library: "docs", paths: ["/회의록"] }, makeCtx());
    expect(folder.isError).toBe(true);
    expect(txt(folder)).toContain("파일만");
    const r = parse(await callTool("download", { library: "docs", paths: ["/README.md"] }, makeCtx({ freePath: async (d, n) => `${d}/(1) ${n}` })));
    expect(r).toEqual({ saved: ["C:/Downloads/U-Drive 작업/(1) README.md"], failed: [] });
    const local = parse(await callTool("download", { library: "docs", paths: ["/README.md"], local_dir: "D:/work" }, makeCtx()));
    expect(local.saved).toEqual(["D:/work/README.md"]);
  });

  it("preview returns a thumbnail image or the text, and refuses other types", async () => {
    const img = await callTool("preview", { library: "docs", path: "/로고.png" }, makeCtx());
    expect(img.content[0]).toMatchObject({ type: "image", mimeType: "image/svg+xml" }); // mock 썸네일은 svg
    expect(atob((img.content[0] as { data: string }).data)).toContain('width="1024"');
    const text = await callTool("preview", { library: "docs", path: "회의록/2026-10-20.md" }, makeCtx());
    expect(text.content[0]).toMatchObject({ type: "text" });
    expect(txt(text).length).toBeGreaterThan(0);
    const pdf = await callTool("preview", { library: "docs", path: "/계약서.pdf" }, makeCtx());
    expect(pdf.isError).toBe(true);
    expect(txt(pdf)).toContain("download");
  });

  it("search maps library names", async () => {
    const entries = [{ id: "1", name: "2026-10-20.md", type: "file" as const, size: 4000, mtime: 0, path: "/회의록/2026-10-20.md", libId: "docs" }];
    const r = parse(await callTool("search", { query: "2026-10" }, makeCtx({ searchIndex: async () => entries })));
    expect(r.results).toEqual([{ library: "docs", libraryName: "문서", path: "/회의록/2026-10-20.md", type: "file", size: "3.9 KB" }]);
  });

  it("search skips shared libraries unless scope is all", async () => {
    const entries = [{ id: "1", name: "공유문서.md", type: "file" as const, size: 1, mtime: 0, path: "/공유문서.md", libId: "family" }];
    const ctx = makeCtx({ searchIndex: async () => entries });
    const mine = parse(await callTool("search", { query: "공유" }, ctx));
    expect(mine.results).toEqual([]);
    expect(mine.note).toContain("scope: all");
    const all = parse(await callTool("search", { query: "공유", scope: "all" }, ctx));
    expect(all.results.map((x: { libraryName: string }) => x.libraryName)).toEqual(["집-공유"]);
  });

  it("recent_downloads reads the default download dir", async () => {
    const recentFiles = vi.fn(async () => [{ name: "a.docx", path: "C:/Downloads/a.docx", size: 1, mtime: 2 }]);
    const r = parse(await callTool("recent_downloads", {}, makeCtx({ recentFiles })));
    expect(recentFiles).toHaveBeenCalledWith("C:/Downloads", 10);
    expect(r).toEqual([{ name: "a.docx", path: "C:/Downloads/a.docx", size: "1 B", modified: expect.stringMatching(/^\d{4}-\d\d-\d\d \d\d:\d\d$/) }]);
  });
});
