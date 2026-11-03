import { formatDate } from "@/lib/format";
import { useLinkState } from "./syncState";
import type { LinkState, SyncLink } from "./type";

function statusText(s: LinkState): string {
  switch (s.status) {
    case "idle":
      return "동기화됨";
    case "syncing":
      return `올리는 중 ${s.pending}개`;
    case "paused":
      return "일시정지됨";
    case "needsConfirm":
      return `확인 필요: 파일 ${s.deleteCount ?? 0}개 삭제 대기`;
    case "localMissing":
      return "PC 폴더를 찾을 수 없음";
    case "driveMissing":
      return "드라이브 폴더를 찾을 수 없음";
    case "error":
      return `오류: ${s.error ?? ""}`;
  }
}

/** 상세 패널의 동기화 폴더 정보 */
export function SyncDetails({ link }: { link: SyncLink }) {
  const st = useLinkState(link.id);
  return (
    <div className="flex flex-col gap-1 text-xs">
      <div className="break-all">PC 폴더 {link.localRoot}</div>
      <div>{statusText(st)}</div>
      {st.lastSyncedAt !== null && <div className="text-muted-foreground">마지막 동기화 {formatDate(Math.floor(st.lastSyncedAt / 1000))}</div>}
    </div>
  );
}
