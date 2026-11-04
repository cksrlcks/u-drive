import { afterEach, describe, expect, it, vi } from "vitest";
import type { Library, StorageProvider } from "@/storage/StorageProvider";
import { treeQuery } from "./useSearchIndex";

const storage = { listTree: async () => [{ name: "a.psd", type: "file", size: 1, mtime: 0, path: "/a.psd" }] } as unknown as StorageProvider;
const lib = (over: Partial<Library>) => ({ id: "lib1", name: "L", size: 0, mtime: 0, encrypted: false, headCommitId: "c1", ...over }) as Library;

describe("treeQuery", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubStorage() {
    const ls = { getItem: vi.fn(() => null), setItem: vi.fn() };
    vi.stubGlobal("localStorage", ls);
    return ls;
  }

  it("일반 저장소는 localStorage에 캐시하고 메모리에 계속 둔다", async () => {
    const ls = stubStorage();
    const q = treeQuery(storage, lib({}));
    expect((await q.queryFn())[0].libId).toBe("lib1");
    expect(ls.setItem).toHaveBeenCalledOnce();
    expect(q.gcTime).toBe(Infinity);
  });

  it("디자인나스는 localStorage를 쓰지 않고 5분 뒤 버린다", async () => {
    const ls = stubStorage();
    const q = treeQuery(storage, lib({ id: "nas:peer", nas: true }));
    expect((await q.queryFn())[0].libId).toBe("nas:peer");
    expect(ls.getItem).not.toHaveBeenCalled();
    expect(ls.setItem).not.toHaveBeenCalled();
    expect(q.gcTime).toBe(5 * 60_000);
  });
});
