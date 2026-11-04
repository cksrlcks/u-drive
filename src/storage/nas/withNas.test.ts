import { describe, expect, it, vi } from "vitest";
import { StorageError, type Library, type StorageProvider } from "../StorageProvider";
import type { NasClient } from "./native";
import { nasUrl, parseNasUrl, withNas } from "./withNas";

const lib: Library = { id: "l1", name: "내 저장소", size: 1, mtime: 1, encrypted: false, section: "내 저장소" };
const inner = {
  token: "tok",
  listLibraries: vi.fn(async () => [lib]),
  listDir: vi.fn(async () => []),
  mkdir: vi.fn(async () => {}),
  isLoggedIn: () => true,
} as unknown as StorageProvider;

function client(over: Partial<NasClient> = {}): NasClient {
  return {
    peers: () => [{ id: "p1", name: "x" }],
    info: async () => ({ name: "디자인나스", version: 42 }),
    list: async (_p, path) => [{ id: path, name: "a", type: "file", size: 1, mtime: 2, path }],
    index: async () => [],
    ...over,
  };
}

describe("withNas", () => {
  it("listLibraries adds one read-only NAS library per peer, uses index version as headCommitId", async () => {
    const libs = await withNas(inner, client()).listLibraries();
    expect(libs[0]).toBe(lib);
    expect(libs[1]).toMatchObject({ id: "nas:p1", name: "디자인나스", section: "NAS", readOnly: true, nas: true, headCommitId: "42", encrypted: false });
  });

  it("peer whose info fails is left out", async () => {
    const p = withNas(inner, client({ peers: () => [{ id: "p1", name: "x" }, { id: "p2", name: "y" }], info: async (id) => { if (id === "p1") throw new Error("x"); return { name: "n", version: 0 }; } }));
    const libs = await p.listLibraries();
    expect(libs.map((l) => l.id)).toEqual(["l1", "nas:p2"]);
  });

  it("listDir / listTree on nas: go to the client", async () => {
    const c = client({ index: vi.fn(async () => []) });
    const p = withNas(inner, c);
    expect((await p.listDir("nas:p1", "/a"))[0].id).toBe("/a");
    await p.listTree("nas:p1");
    expect(c.index).toHaveBeenCalledWith("p1");
  });

  it("list error becomes network StorageError", async () => {
    const p = withNas(inner, client({ list: async () => { throw new Error("boom"); } }));
    await expect(p.listDir("nas:p1", "/")).rejects.toMatchObject({ kind: "network", message: "디자인나스에 연결할 수 없습니다. 서버 PC의 Drive 앱이 켜져 있는지 확인하세요" });
  });

  it("downloadUrl gives nas:// url and parseNasUrl reverses it", async () => {
    const p = withNas(inner, client());
    const url = await p.downloadUrl("nas:p1", "/시안 폴더/a b.psd");
    expect(url).toBe(nasUrl("p1", "/시안 폴더/a b.psd"));
    expect(parseNasUrl(nasUrl("a._udrive._tcp.local.", "/시안 폴더/a b.psd"))).toEqual({ peerId: "a._udrive._tcp.local.", path: "/시안 폴더/a b.psd" });
    expect(parseNasUrl("https://x")).toBeNull();
  });

  it("mutations and thumbnail on nas: reject, other libIds pass through", async () => {
    const p = withNas(inner, client());
    await expect(p.mkdir("nas:p1", "/x")).rejects.toBeInstanceOf(StorageError);
    await expect(p.thumbnail("nas:p1", "/x", 10)).rejects.toMatchObject({ message: "디자인나스는 내려받기만 할 수 있습니다" });
    expect(await p.listTrash("nas:p1")).toEqual([]);
    await p.mkdir("l1", "/x");
    expect(inner.mkdir).toHaveBeenCalledWith("l1", "/x");
    expect(p.token).toBe("tok");
    expect(p.isLoggedIn()).toBe(true);
  });
});
