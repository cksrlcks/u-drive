import { useQueries, type QueryClient } from "@tanstack/react-query";
import { useLibraries } from "@/features/browse/useCurrentDir";
import { useStorage } from "@/storage/StorageContext";
import type { Entry, Library, StorageProvider } from "@/storage/StorageProvider";

export interface IndexedEntry extends Entry {
  libId: string;
}

const KEY = (libId: string) => `seadrive.index.${libId}`;
/** 받은 색인을 이만큼은 그대로 쓴다. 업로드·동기화로 커밋이 몇 초마다 바뀌어도 전체 트리를 다시 받지 않게 */
export const TREE_FRESH_MS = 5 * 60_000;

/** 이번 실행 동안의 캐시. localStorage(약 5MB)에 안 들어가는 큰 저장소도 커밋이 같으면 다시 받지 않는다 */
const mem = new Map<string, { commit: string; entries: Entry[] }>();

function load(libId: string, commit: string): Entry[] | null {
  const m = mem.get(libId);
  if (m?.commit === commit) return m.entries;
  try {
    const c = JSON.parse(localStorage.getItem(KEY(libId)) ?? "null") as { commit: string; entries: Entry[] } | null;
    return c && c.commit === commit ? c.entries : null;
  } catch {
    return null;
  }
}

function save(libId: string, commit: string, entries: Entry[]) {
  mem.set(libId, { commit, entries });
  try {
    localStorage.setItem(KEY(libId), JSON.stringify({ commit, entries }));
  } catch {
    // localStorage를 넘는 큰 저장소는 이번 실행의 메모리 캐시만 쓴다. 앱을 다시 켜면 처음 검색할 때 한 번 받는다
  }
}

/** 저장소 하나의 색인 쿼리. 키에 커밋을 넣지 않아 커밋이 바뀌어도 TREE_FRESH_MS 동안은 다시 받지 않는다 */
export function treeQuery(storage: StorageProvider, lib: Library) {
  return {
    queryKey: ["tree", lib.id],
    queryFn: async (): Promise<IndexedEntry[]> => {
      const commit = lib.headCommitId ?? "";
      let entries = commit ? load(lib.id, commit) : null;
      if (!entries) {
        entries = await storage.listTree(lib.id);
        if (commit) save(lib.id, commit, entries);
      }
      return entries.map((e) => ({ ...e, libId: lib.id }));
    },
    staleTime: TREE_FRESH_MS,
    gcTime: Infinity,
    retry: 1,
  };
}

const combine = (rs: { data?: IndexedEntry[]; isPending: boolean; isError: boolean }[]) => ({
  entries: rs.flatMap((r) => r.data ?? []),
  loading: rs.some((r) => r.isPending),
  failed: rs.filter((r) => r.isError).length,
});

/**
 * 전 저장소의 파일·폴더 목록(통합 검색용). 암호화 저장소는 제외.
 * enabled일 때만 받는다(검색창을 눌렀을 때). 전체 트리는 무거운 요청이라 로그인·업로드 때마다 받으면
 * 큰 저장소에서 서버가 504로 밀리고 같은 저장소의 폴더 목록까지 시간 초과가 났다.
 */
export function useSearchIndex(enabled: boolean) {
  const storage = useStorage();
  const libs = (useLibraries().data ?? []).filter((l) => !l.encrypted);
  return useQueries({ queries: libs.map((lib) => ({ ...treeQuery(storage, lib), enabled })), combine });
}

/** 화면 밖(Claude 검색 도구)에서 색인이 필요할 때 받아 온다. 받아 둔 게 TREE_FRESH_MS 안이면 그대로 쓴다 */
export async function fetchSearchIndex(qc: QueryClient, storage: StorageProvider): Promise<IndexedEntry[]> {
  const libs = await qc.ensureQueryData({ queryKey: ["libraries"], queryFn: () => storage.listLibraries() });
  const rs = await Promise.allSettled(libs.filter((l) => !l.encrypted).map((l) => qc.fetchQuery(treeQuery(storage, l))));
  return rs.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
}
