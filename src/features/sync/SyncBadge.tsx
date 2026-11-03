import { IconRefresh } from "@tabler/icons-react";
import { cn } from "cn";
import { isSyncProblem } from "./constants";
import { useLinkState } from "./syncState";

/** 동기화 폴더 아이콘 모서리 배지. 위치는 호출하는 쪽이 className으로 정한다(absolute). 상태는 배지만 구독해 진행 알림에 목록 전체가 다시 그려지지 않는다 */
export function SyncBadge({ linkId, className }: { linkId: string; className?: string }) {
  const { status } = useLinkState(linkId);
  return (
    <span className={cn("absolute flex size-4 items-center justify-center rounded-full bg-card shadow-item", className)} aria-label="동기화 폴더">
      <IconRefresh className={cn("size-2.5", isSyncProblem(status) ? "text-destructive" : status === "paused" ? "text-muted-foreground" : "text-primary")} stroke={2.5} />
    </span>
  );
}
