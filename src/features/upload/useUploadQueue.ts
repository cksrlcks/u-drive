import { useQueryClient } from "@tanstack/react-query";
import { createContext, createElement, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { useSession, useStorage } from "@/storage/StorageContext";
import { UploadQueue, type UploadItem } from "./uploadQueue";

const Ctx = createContext<UploadQueue | null>(null);

/** 앱 수명 동안 하나(Provider가 바뀌면 새로). 완료 시 해당 폴더 쿼리 무효화, 401이면 로그인 화면으로. */
export function UploadQueueRoot({ children }: { children: ReactNode }) {
  const storage = useStorage();
  const { onUnauthorized } = useSession();
  const qc = useQueryClient();
  const queue = useMemo(() => new UploadQueue(storage), [storage]);
  useEffect(() => {
    queue.onAllDone = (libId, dirs) => {
      for (const d of dirs) void qc.invalidateQueries({ queryKey: ["dir", libId, d] });
      void qc.invalidateQueries({ queryKey: ["account"] });
      void qc.invalidateQueries({ queryKey: ["libraries"] }); // 사용량·head commit 갱신(검색 색인은 TREE_FRESH_MS가 지난 뒤 검색할 때 다시 받는다)
    };
    queue.onUnauthorized = () => {
      queue.cancelAll();
      onUnauthorized();
    };
    return () => queue.cancelAll(); // Provider 교체(로그아웃)되면 진행 중 XHR 중단
  }, [queue, qc, onUnauthorized]);
  return createElement(Ctx.Provider, { value: queue }, children);
}

/** 큐만 쓴다: 진행 알림(초당 수십 번)에 다시 그리지 않는다 */
export function useUploadQueueInstance(): UploadQueue {
  const queue = useContext(Ctx);
  if (!queue) throw new Error("useUploadQueue outside UploadQueueRoot");
  return queue;
}

export function useUploadQueue(): { queue: UploadQueue; items: UploadItem[] } {
  const queue = useUploadQueueInstance();
  const items = useSyncExternalStore(queue.subscribe, queue.getSnapshot);
  return { queue, items };
}
