import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { Library, StorageProvider } from "@/storage/StorageProvider";
import { fetchSearchIndex, TREE_FRESH_MS } from "./useSearchIndex";

function setup(id: string) {
  const lib = { id, name: "L", headCommitId: "c1", encrypted: false } as Library;
  const listTree = vi.fn(async () => [{ id: "1", name: "a.txt", type: "file" as const, size: 1, mtime: 0, path: "/a.txt" }]);
  const storage = { listLibraries: async () => [lib], listTree } as unknown as StorageProvider;
  const qc = new QueryClient();
  qc.setQueryData(["libraries"], [lib]);
  return { lib, listTree, storage, qc };
}

describe("fetchSearchIndex", () => {
  it("5분 안에는 커밋이 바뀌어도 전체 트리를 다시 받지 않는다", async () => {
    const { lib, listTree, storage, qc } = setup("fresh");
    expect(await fetchSearchIndex(qc, storage)).toEqual([expect.objectContaining({ name: "a.txt", libId: "fresh" })]);
    qc.setQueryData(["libraries"], [{ ...lib, headCommitId: "c2" }]); // 업로드로 커밋이 바뀜
    await fetchSearchIndex(qc, storage);
    expect(listTree).toHaveBeenCalledTimes(1);
  });

  it("5분이 지나면 바뀐 커밋만 다시 받는다", async () => {
    vi.useFakeTimers();
    try {
      const { lib, listTree, storage, qc } = setup("stale");
      await fetchSearchIndex(qc, storage);
      vi.advanceTimersByTime(TREE_FRESH_MS + 1);
      await fetchSearchIndex(qc, storage); // 커밋 그대로 → 메모리 캐시
      expect(listTree).toHaveBeenCalledTimes(1);
      qc.setQueryData(["libraries"], [{ ...lib, headCommitId: "c2" }]);
      vi.advanceTimersByTime(TREE_FRESH_MS + 1);
      await fetchSearchIndex(qc, storage);
      expect(listTree).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
