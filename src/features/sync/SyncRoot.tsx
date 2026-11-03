import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { isTauri } from "@/features/shell/platform";
import { useUploadQueueInstance } from "@/features/upload/useUploadQueue";
import { logError } from "@/lib/errorLog";
import { useSession, useStorage } from "@/storage/StorageContext";
import { StorageError } from "@/storage/StorageProvider";
import { FULL_SCAN_MS, SETTLE_SEC } from "./constants";
import { accountKey, getLinks, updateLink, useLinks } from "./links";
import { MassDeleteDialog } from "./MassDeleteDialog";
import { onFolderChanged, readBaseline, scanFolder, unwatchFolder, watchFolder, writeBaseline } from "./native";
import { runLink } from "./runLink";
import { createScheduler, linkTriggers, setLinkState } from "./syncState";
import type { SyncLink } from "./type";

const WATCH_RETRY_MS = 60_000;

/** 연결 하나의 감시·실행. 일시정지면 아무것도 하지 않는다 */
function LinkEngine({ link }: { link: SyncLink }) {
  const storage = useStorage();
  const { onUnauthorized } = useSession();
  const queue = useUploadQueueInstance();
  const qc = useQueryClient();
  const unauth = useRef(onUnauthorized);
  unauth.current = onUnauthorized;
  const { id, localRoot, paused, account } = link;

  useEffect(() => {
    if (paused) {
      setLinkState(id, { status: "paused", pending: 0 });
      return;
    }
    let alive = true;
    const stop = new AbortController(); // 정리될 때(일시정지·해제·로그아웃·폴더 변경) 도는 실행을 멈춘다
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    let watching = false;
    const run = async (opts: { confirmedDeletes?: boolean }) => {
      // 실행 중 바뀐 값(fresh, 이동한 drivePath)을 읽으려고 매번 저장소에서 다시 가져온다
      const cur = getLinks(account).find((l) => l.id === id);
      if (!alive || !cur) return;
      setLinkState(id, { status: "syncing" });
      try {
        const r = await runLink(
          cur,
          {
            storage,
            uploads: queue,
            scan: scanFolder,
            readBase: readBaseline,
            writeBase: writeBaseline,
            nowSec: () => Math.floor(Date.now() / 1000),
            onPending: (pending) => alive && setLinkState(id, { pending }),
          },
          { ...opts, signal: stop.signal },
        );
        if (!alive) return;
        // 올린 파일은 업로드 큐가 갱신하지만, 동기화가 지우거나 만든 폴더는 여기서 다시 읽어야 보인다
        void qc.invalidateQueries({ queryKey: ["dir", cur.libId] });
        if (r.status === "idle") {
          setLinkState(id, { status: "idle", pending: 0, lastSyncedAt: Date.now(), error: undefined, deleteCount: undefined });
          if (cur.fresh) updateLink(id, { fresh: false });
          if (r.deferred > 0) settleTimer = setTimeout(() => auto(), SETTLE_SEC * 1000);
        } else if (r.status === "needsConfirm") {
          setLinkState(id, { status: "needsConfirm", pending: 0, deleteCount: r.deleteCount });
        } else {
          if (r.status === "localMissing" && watching) {
            // 죽은 감시자는 다시 안 울린다: 풀어 두면 60초 재시도가 다시 걸고 실행한다
            watching = false;
            void unwatchFolder(id);
          }
          setLinkState(id, { status: r.status, pending: 0 });
        }
      } catch (e) {
        if (e instanceof StorageError && e.kind === "unauthorized") return unauth.current();
        logError("sync", e);
        if (alive) setLinkState(id, { status: "error", pending: 0, error: e instanceof Error ? e.message : "동기화에 실패했습니다" });
      }
    };
    const trigger = createScheduler(id, run);
    const tryWatch = async () => {
      try {
        await watchFolder(id, localRoot);
        watching = true;
        return true;
      } catch (e) {
        logError("sync", e);
        return false;
      }
    };
    const { auto, off: unRunner } = linkTriggers(id, trigger);
    const unlisten = onFolderChanged((changed) => changed === id && auto());
    // 감시를 못 걸어도 폴더가 있으면 계속 돈다(1시간 전체 비교·60초마다 감시 재시도). 없어졌는지는 실행의 훑기 결과로만 판단한다
    void tryWatch().then(() => alive && auto());
    const full = setInterval(() => auto(), FULL_SCAN_MS);
    const retry = setInterval(() => !watching && void tryWatch().then((ok) => ok && alive && auto()), WATCH_RETRY_MS);
    return () => {
      alive = false;
      stop.abort();
      clearTimeout(settleTimer);
      clearInterval(full);
      clearInterval(retry);
      unRunner();
      void unlisten.then((f) => f());
      void unwatchFolder(id); // 아직 시작 중인 감시도 새지 않게 항상 푼다
    };
  }, [id, localRoot, paused, account, storage, queue]);

  return null;
}

/** 로그인해 있는 동안 연결된 PC 폴더를 드라이브로 맞춘다(화면 없음, 대량 삭제 확인 창만 띄운다) */
export function SyncRoot() {
  const storage = useStorage();
  const { session } = useSession();
  const acc = useQuery({ queryKey: ["account"], queryFn: () => storage.getAccount(), staleTime: 30_000, enabled: isTauri() });
  const account = acc.data?.email ? accountKey(session.connection.baseUrl, acc.data.email) : "";
  const links = useLinks(account);
  if (!isTauri() || !account) return null;
  return (
    <>
      {links.map((l) => (
        <LinkEngine key={l.id} link={l} />
      ))}
      <MassDeleteDialog links={links} />
    </>
  );
}
