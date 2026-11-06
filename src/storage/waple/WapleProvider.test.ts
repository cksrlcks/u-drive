import { afterEach, describe, expect, it, vi } from "vitest";
import { StorageError } from "../StorageProvider";
import { WapleProvider } from "./WapleProvider";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const empty = (status = 204) => new Response(null, { status });

afterEach(() => fetchMock.mockReset());

const p = () => new WapleProvider("https://host.example:8443/", "t");
const lastCall = () => fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as [string, RequestInit];
const bodyOf = (call: [string, RequestInit]) => JSON.parse(String(call[1].body)) as Record<string, unknown>;

describe("WapleProvider", () => {
  it("login sends email + snake_case device and stores the token", async () => {
    fetchMock.mockResolvedValue(json({ token: "abc" }));
    const prov = new WapleProvider("https://host.example:8443", null);
    await prov.login("me@test", "pw", undefined, { platform: "windows", deviceId: "d".repeat(40), deviceName: "내 PC", clientVersion: "0.13.2" });
    const [url, init] = lastCall();
    expect(url).toBe("https://host.example:8443/api/v1/auth/login");
    expect(init.method).toBe("POST");
    expect(bodyOf([url, init])).toEqual({
      email: "me@test",
      password: "pw",
      device: { platform: "windows", device_id: "d".repeat(40), device_name: "내 PC", client_version: "0.13.2" },
    });
    expect(prov.token).toBe("abc");
    expect(prov.isLoggedIn()).toBe(true);
  });

  it("logout posts with the token and clears it even when the server fails", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 500 }));
    const prov = p();
    await prov.logout();
    const [url, init] = lastCall();
    expect(url).toBe("https://host.example:8443/api/v1/auth/logout");
    expect(new Headers(init.headers).get("Authorization")).toBe("Token t");
    expect(prov.isLoggedIn()).toBe(false);
  });

  it("maps { message } error bodies to StorageError by status", async () => {
    fetchMock.mockResolvedValue(json({ message: "인증이 필요합니다" }, 401));
    await expect(p().getAccount()).rejects.toMatchObject({ kind: "unauthorized", message: "인증이 필요합니다", status: 401 });
    fetchMock.mockResolvedValue(json({ message: "저장소를 찾을 수 없습니다" }, 404));
    await expect(p().listDir("r", "/")).rejects.toMatchObject({ kind: "notFound", status: 404 });
    fetchMock.mockResolvedValue(json({ message: "저장 공간이 부족합니다" }, 507));
    await expect(p().mkdir("r", "/x")).rejects.toMatchObject({ kind: "server", message: "저장 공간이 부족합니다", status: 507 });
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(p().getAccount()).rejects.toMatchObject({ kind: "network" });
  });

  it("getAccount and listGroups map directly", async () => {
    fetchMock.mockResolvedValueOnce(json({ name: "나", email: "me@test", usage: 10, quota: null }));
    expect(await p().getAccount()).toEqual({ name: "나", email: "me@test", usage: 10, quota: null });
    fetchMock.mockResolvedValueOnce(json([{ id: 1, name: "개발" }, { id: 2, name: "디자인" }]));
    expect(await p().listGroups()).toEqual(["개발", "디자인"]);
    expect(lastCall()[0]).toBe("https://host.example:8443/api/v1/me/groups");
  });

  it("listLibraries maps section, permission and starred", async () => {
    fetchMock.mockResolvedValue(
      json([
        { id: "a", name: "A", size: 1, mtime: 2, head_commit_id: "h1", section: "own", starred: true, permission: "rw" },
        { id: "b", name: "B", size: 3, mtime: 4, head_commit_id: "h2", section: "shared", starred: false, permission: "r" },
      ]),
    );
    expect(await p().listLibraries()).toEqual([
      { id: "a", name: "A", size: 1, mtime: 2, encrypted: false, headCommitId: "h1", section: "내 저장소", starred: true, readOnly: false },
      { id: "b", name: "B", size: 3, mtime: 4, encrypted: false, headCommitId: "h2", section: "나에게 공유됨", starred: false, readOnly: true },
    ]);
  });

  it("renameLibrary and starLibrary hit the repo routes", async () => {
    fetchMock.mockResolvedValue(json({ id: "r", name: "새" }));
    await p().renameLibrary("r", "새");
    expect(lastCall()[0]).toBe("https://host.example:8443/api/v1/repos/r");
    expect(lastCall()[1].method).toBe("PATCH");
    expect(bodyOf(lastCall())).toEqual({ name: "새" });
    fetchMock.mockResolvedValue(empty());
    await p().starLibrary("r", true);
    expect(lastCall()[0]).toBe("https://host.example:8443/api/v1/repos/r/star");
    expect(lastCall()[1].method).toBe("PUT");
    await p().starLibrary("r", false);
    expect(lastCall()[1].method).toBe("DELETE");
  });

  it("listDir sorts folders first then by name, listTree passes through", async () => {
    fetchMock.mockResolvedValue(
      json([
        { id: "1", name: "b.txt", type: "file", size: 5, mtime: 1, path: "/d/b.txt" },
        { id: "2", name: "z", type: "dir", size: 0, mtime: 1, path: "/d/z" },
        { id: "3", name: "a.txt", type: "file", size: 5, mtime: 1, path: "/d/a.txt" },
      ]),
    );
    const items = await p().listDir("r", "/d");
    expect(lastCall()[0]).toBe("https://host.example:8443/api/v1/repos/r/dir?path=%2Fd");
    expect(items.map((e) => e.name)).toEqual(["z", "a.txt", "b.txt"]);
    expect(items[1]).toEqual({ id: "3", name: "a.txt", type: "file", size: 5, mtime: 1, path: "/d/a.txt" });
    fetchMock.mockResolvedValue(json([{ id: "1", name: "x", type: "dir", size: 0, mtime: 9, path: "/x" }]));
    expect(await p().listTree("r")).toEqual([{ id: "1", name: "x", type: "dir", size: 0, mtime: 9, path: "/x" }]);
    expect(lastCall()[0]).toBe("https://host.example:8443/api/v1/repos/r/tree");
  });

  it("downloadUrl posts /file/link and returns the signed url; thumbnail fetches a blob", async () => {
    fetchMock.mockImplementation(async () => json({ url: "https://host.example:8443/dl/tok", expires_at: 1 }));
    expect(await p().downloadUrl("r", "/a b.txt")).toBe("https://host.example:8443/dl/tok");
    expect(lastCall()[0]).toBe("https://host.example:8443/api/v1/repos/r/file/link?path=%2Fa+b.txt");
    expect(lastCall()[1].method).toBe("POST");
    expect(await p().previewUrl("r", "/a b.txt")).toBe("https://host.example:8443/dl/tok");
    fetchMock.mockImplementation(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "Content-Type": "image/jpeg" } }));
    const blob = await p().thumbnail("r", "/p.png", 64);
    expect(blob.size).toBe(3);
    expect(lastCall()[0]).toBe("https://host.example:8443/api/v1/repos/r/thumbnail?path=%2Fp.png&size=64");
  });

  it("mkdir, rename, remove, move use the file-ops routes", async () => {
    fetchMock.mockResolvedValue(json({ id: "x" }, 201));
    await p().mkdir("r", "/a/b");
    expect(lastCall()[0]).toBe("https://host.example:8443/api/v1/repos/r/dir?path=%2Fa%2Fb");
    expect(lastCall()[1].method).toBe("POST");
    fetchMock.mockResolvedValue(json({ path: "/a/c" }));
    await p().rename("r", "/a/b", "c", "dir");
    expect(lastCall()[0]).toBe("https://host.example:8443/api/v1/repos/r/rename");
    expect(bodyOf(lastCall())).toEqual({ path: "/a/b", new_name: "c" });
    fetchMock.mockResolvedValue(empty());
    await p().remove("r", "/a/c", "dir");
    expect(lastCall()[0]).toBe("https://host.example:8443/api/v1/repos/r/entry?path=%2Fa%2Fc");
    expect(lastCall()[1].method).toBe("DELETE");
    await p().move("r", "/src", ["x", "y"], "/dst");
    expect(lastCall()[0]).toBe("https://host.example:8443/api/v1/repos/r/move");
    expect(bodyOf(lastCall())).toEqual({ src_dir: "/src", names: ["x", "y"], dst_dir: "/dst" });
  });

  it("share links map fields", async () => {
    fetchMock.mockResolvedValue(json({ token: "tk", url: "https://host.example:8443/s/tk", expires_at: 1_800_000_000 }, 201));
    expect(await p().createShareLink("r", "/a.txt", { password: "pw", expireDays: 7 })).toEqual({ url: "https://host.example:8443/s/tk", expiresAt: 1_800_000_000 });
    expect(bodyOf(lastCall())).toEqual({ repo_id: "r", path: "/a.txt", password: "pw", expire_days: 7 });
    fetchMock.mockResolvedValue(json({ token: "tk", url: "u", expires_at: null }, 201));
    expect(await p().createShareLink("r", "/a.txt")).toEqual({ url: "u" });
    expect(bodyOf(lastCall())).toEqual({ repo_id: "r", path: "/a.txt" });
    fetchMock.mockResolvedValue(
      json([{ token: "tk", url: "u", repo_id: "r", repo_name: "R", path: "/a.txt", name: "a.txt", type: "file", expires_at: null, expired: false, protected: true, views: 3, created_at: 5 }]),
    );
    expect(await p().listShareLinks()).toEqual([
      { token: "tk", url: "u", libId: "r", libName: "R", path: "/a.txt", name: "a.txt", type: "file", expiresAt: undefined, expired: false, protected: true, views: 3, createdAt: 5 },
    ]);
    fetchMock.mockResolvedValue(empty());
    await p().deleteShareLink("tk");
    expect(lastCall()[0]).toBe("https://host.example:8443/api/v1/share-links/tk");
    expect(lastCall()[1].method).toBe("DELETE");
  });

  it("trash maps fields and restore sends commit_id + full path", async () => {
    fetchMock.mockResolvedValue(json([{ name: "a.txt", type: "file", size: 9, parent_dir: "/docs", deleted_at: 7, commit_id: "c1" }]));
    const list = await p().listTrash("r");
    expect(list).toEqual([{ name: "a.txt", type: "file", size: 9, parentDir: "/docs", deletedAt: 7, commitId: "c1" }]);
    fetchMock.mockResolvedValue(empty());
    await p().restoreTrash("r", list[0]);
    expect(lastCall()[0]).toBe("https://host.example:8443/api/v1/repos/r/trash/restore");
    expect(bodyOf(lastCall())).toEqual({ commit_id: "c1", path: "/docs/a.txt" });
    await p().emptyTrash("r");
    expect(lastCall()[0]).toBe("https://host.example:8443/api/v1/repos/r/trash");
    expect(lastCall()[1].method).toBe("DELETE");
  });

  it("readText decodes utf-8 and falls back to euc-kr", async () => {
    fetchMock.mockResolvedValueOnce(json({ url: "https://host.example:8443/dl/tok", expires_at: 1 }));
    fetchMock.mockResolvedValueOnce(new Response(new TextEncoder().encode("한글"), { status: 200 }));
    expect(await p().readText("r", "/a.txt")).toBe("한글");
    expect(fetchMock.mock.calls[1][0]).toBe("https://host.example:8443/dl/tok");
  });

  it("surfaces StorageError instances", () => {
    expect(new StorageError("network", "x")).toBeInstanceOf(Error);
  });
});
