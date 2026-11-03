import { IconRefresh } from "@tabler/icons-react";
import { cn } from "cn";
import { isSyncProblem } from "./constants";
import type { SyncStatus } from "./type";

/** 동기화 폴더 아이콘 모서리 배지. 위치는 호출하는 쪽이 className으로 정한다(absolute) */
export function SyncBadge({ status, className }: { status: SyncStatus; className?: string }) {
  return (
    <span className={cn("absolute flex size-4 items-center justify-center rounded-full bg-card shadow-item", className)} aria-label="동기화 폴더">
      <IconRefresh className={cn("size-2.5", isSyncProblem(status) ? "text-destructive" : status === "paused" ? "text-muted-foreground" : "text-primary")} stroke={2.5} />
    </span>
  );
}
