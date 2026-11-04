import { useQueries } from "@tanstack/react-query";
import { useLibraries } from "@/features/browse/useCurrentDir";
import { useStorage } from "@/storage/StorageContext";
import type { Entry, Library, StorageProvider } from "@/storage/StorageProvider";

export interface IndexedEntry extends Entry {
  libId: string;
}

const KEY = (libId: string) => `seadrive.index.${libId}`;

function load(libId: string, commit: string): Entry[] | null {
  try {
    const c = JSON.parse(localStorage.getItem(KEY(libId)) ?? "null") as { commit: string; entries: Entry[] } | null;
    return c && c.commit === commit ? c.entries : null;
  } catch {
    return null;
  }
}

function save(libId: string, commit: string, entries: Entry[]) {
  try {
    localStorage.setItem(KEY(libId), JSON.stringify({ commit, entries }));
  } catch {
    // shortcut: localStorage 용량(약 5MB)을 넘는 큰 저장소는 캐시 없이 매번 받는다. 자주 걸리면 IndexedDB로
  }
}

const combine = (rs: { data?: IndexedEntry[]; isPending: boolean; isError: boolean }[]) => ({
  entries: rs.flatMap((r) => r.data ?? []),
  loading: rs.some((r) => r.isPending),
  failed: rs.filter((r) => r.isError).length,
});

/** 디자인나스 색인은 안 쓰면 이만큼 뒤 메모리에서 버린다 */
const NAS_GC_MS = 5 * 60_000;

/**
 * 저장소 하나의 색인 쿼리. headCommitId를 쿼리 키로 써서 내용이 바뀐 저장소만 다시 받고, 같으면 localStorage 캐시를 쓴다.
 * 디자인나스는 id에 실행마다 바뀌는 지문이 들어가 저장하면 쌓이기만 하므로 localStorage에 두지 않는다.
 */
export function treeQuery(storage: StorageProvider, lib: Library) {
  return {
    queryKey: ["tree", lib.id, lib.headCommitId ?? ""],
    queryFn: async (): Promise<IndexedEntry[]> => {
      const commit = lib.nas ? "" : (lib.headCommitId ?? "");
      let entries = commit ? load(lib.id, commit) : null;
      if (!entries) {
        entries = await storage.listTree(lib.id);
        if (commit) save(lib.id, commit, entries);
      }
      return entries.map((e) => ({ ...e, libId: lib.id }));
    },
    staleTime: Infinity,
    gcTime: lib.nas ? NAS_GC_MS : Infinity,
    retry: 1,
  };
}

/** 전 저장소의 파일·폴더 목록(통합 검색용). 암호화 저장소는 제외. */
export function useSearchIndex() {
  const storage = useStorage();
  const libs = (useLibraries().data ?? []).filter((l) => !l.encrypted);
  return useQueries({
    queries: libs.map((lib) => treeQuery(storage, lib)),
    combine,
  });
}
