import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { isTauri } from "@/features/shell/platform";
import { useUploadQueue } from "@/features/upload/useUploadQueue";
import { logError } from "@/lib/errorLog";
import { useSession, useStorage } from "@/storage/StorageContext";
import { StorageError } from "@/storage/StorageProvider";
import { FULL_SCAN_MS, SETTLE_SEC } from "./constants";
import { accountKey, getLinks, updateLink, useLinks } from "./links";
import { MassDeleteDialog } from "./MassDeleteDialog";
import { onFolderChanged, readBaseline, scanFolder, unwatchFolder, watchFolder, writeBaseline } from "./native";
import { runLink } from "./runLink";
import { createScheduler, registerRunner, setLinkState } from "./syncState";
import type { SyncLink } from "./type";

const WATCH_RETRY_MS = 60_000;

/** 연결 하나의 감시·실행. 일시정지면 아무것도 하지 않는다 */
function LinkEngine({ link }: { link: SyncLink }) {
  const storage = useStorage();
  const { onUnauthorized } = useSession();
  const { queue } = useUploadQueue();
  const unauth = useRef(onUnauthorized);
  unauth.current = onUnauthorized;
  const { id, localRoot, paused, account } = link;

  useEffect(() => {
    if (paused) {
      setLinkState(id, { status: "paused", pending: 0 });
      return;
    }
    let alive = true;
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
          opts,
        );
        if (!alive) return;
        if (r.status === "idle") {
          setLinkState(id, { status: "idle", pending: 0, lastSyncedAt: Date.now(), error: undefined, deleteCount: undefined });
          if (cur.fresh) updateLink(id, { fresh: false });
          if (r.deferred > 0) settleTimer = setTimeout(() => trigger(), SETTLE_SEC * 1000);
        } else if (r.status === "needsConfirm") {
          setLinkState(id, { status: "needsConfirm", pending: 0, deleteCount: r.deleteCount });
        } else {
          setLinkState(id, { status: r.status, pending: 0 });
        }
      } catch (e) {
        if (e instanceof StorageError && e.kind === "unauthorized") return unauth.current();
        logError("sync", e);
        if (alive) setLinkState(id, { status: "error", pending: 0, error: e instanceof Error ? e.message : "동기화에 실패했습니다" });
      }
    };
    const trigger = createScheduler(run);
    const tryWatch = async () => {
      try {
        await watchFolder(id, localRoot);
        watching = true;
        return true;
      } catch {
        return false;
      }
    };
    const unRunner = registerRunner(id, trigger);
    const unlisten = onFolderChanged((changed) => changed === id && trigger());
    void tryWatch().then((ok) => {
      if (!alive) return;
      if (ok) trigger();
      else setLinkState(id, { status: "localMissing", pending: 0 });
    });
    const full = setInterval(() => trigger(), FULL_SCAN_MS);
    const retry = setInterval(() => !watching && void tryWatch().then((ok) => ok && alive && trigger()), WATCH_RETRY_MS);
    return () => {
      alive = false;
      clearTimeout(settleTimer);
      clearInterval(full);
      clearInterval(retry);
      unRunner();
      void unlisten.then((f) => f());
      if (watching) void unwatchFolder(id);
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
