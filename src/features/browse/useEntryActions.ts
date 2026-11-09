import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useStorage } from "@/storage/StorageContext";
import { joinPath, parentPath } from "@/storage/path";
import type { Entry } from "@/storage/StorageProvider";
import { followMoveAll } from "@/features/sync/links";
import { downloadEntries } from "@/features/download/useDownloads";
import type { Location } from "./useCurrentDir";

export interface MoveOp {
  libId: string;
  srcDir: string;
  names: string[];
  dstDir: string;
}

export function useEntryActions(loc: Location) {
  const storage = useStorage();
  const qc = useQueryClient();
  const libId = loc.libId!;
  const refresh = (path: string) => {
    void qc.invalidateQueries({ queryKey: ["libraries"] }); // head commit이 바뀌어 검색 인덱스가 갱신되도록
    return qc.invalidateQueries({ queryKey: ["dir", libId, path] });
  };

  const mkdir = useMutation({
    mutationFn: (name: string) => storage.mkdir(libId, joinPath(loc.path, name)),
    onSuccess: () => refresh(loc.path),
  });
  const rename = useMutation({
    mutationFn: ({ entry, newName }: { entry: Entry; newName: string }) => storage.rename(libId, entry.path, newName, entry.type),
    onSuccess: (_d, { entry, newName }) => {
      followMoveAll(libId, entry.path, joinPath(parentPath(entry.path), newName));
      return refresh(parentPath(entry.path));
    },
  });
  const remove = useMutation({
    mutationFn: (entry: Entry) => storage.remove(libId, entry.path, entry.type),
    onSuccess: (_d, entry) => {
      void refresh(parentPath(entry.path));
      void qc.invalidateQueries({ queryKey: ["account"] });
    },
  });
  /** 대상 폴더에 같은 이름이 있으면 옮기지 않는다(덮어쓰기·자동 이름 변경 없음). 실행 취소도 이걸로 되돌려 옮긴다 */
  const move = useMutation({
    mutationFn: async ({ libId, srcDir, names, dstDir }: MoveOp) => {
      const taken = new Set((await storage.listDir(libId, dstDir)).map((e) => e.name));
      const dup = names.find((n) => taken.has(n));
      if (dup) throw new Error(`'${dup}' 이름이 대상 폴더에 이미 있습니다`);
      await storage.move(libId, srcDir, names, dstDir);
    },
    onSuccess: (_d, { libId, srcDir, names, dstDir }) => {
      for (const n of names) followMoveAll(libId, joinPath(srcDir, n), joinPath(dstDir, n));
      void qc.invalidateQueries({ queryKey: ["libraries"] });
      // 옮긴 폴더의 하위 목록 캐시까지 낡으므로 저장소 전체를 다시 읽는다
      return qc.invalidateQueries({ queryKey: ["dir", libId] });
    },
  });
  /** 파일 1개는 저장 위치 선택, 여러 개·폴더는 폴더 선택. 실제 전송은 다운로드 패널에서 진행 */
  const download = useMutation({
    mutationFn: (entries: Entry[]) =>
      downloadEntries(
        entries,
        (e) => storage.downloadUrl(libId, e.path),
        (p) => storage.listDir(libId, p),
      ),
  });

  const labels = { mkdir: "새 폴더를 만들지 못했습니다", rename: "이름을 바꾸지 못했습니다", remove: "삭제하지 못했습니다", move: "옮기지 못했습니다", download: "다운로드를 시작하지 못했습니다" };
  const failed = ([["mkdir", mkdir], ["rename", rename], ["remove", remove], ["move", move], ["download", download]] as const).find(([, m]) => m.error);
  const error = failed ? { message: labels[failed[0]], detail: (failed[1].error as Error).message, reset: () => failed[1].reset() } : null;

  return { mkdir, rename, remove, move, download, error };
}
