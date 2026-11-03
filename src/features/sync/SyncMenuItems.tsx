import { IconFolderSearch, IconPlayerPause, IconPlayerPlay, IconRefresh, IconUnlink } from "@tabler/icons-react";
import { ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import { logError } from "@/lib/errorLog";
import { updateLink } from "./links";
import { releaseHold, requestRun } from "./syncState";
import type { SyncLink } from "./type";

/** 연결 폴더 우클릭 메뉴의 관리 항목(구분선 포함) */
export function SyncMenuItems({ link, onUnsync }: { link: SyncLink; onUnsync?(link: SyncLink): void }) {
  const { id, paused, localRoot } = link;
  return (
    <>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => void import("@tauri-apps/plugin-opener").then((m) => m.revealItemInDir(localRoot)).catch((e) => logError("sync", e))}className="text-sm">
        <IconFolderSearch className="size-4" /> PC 폴더 열기
      </ContextMenuItem>
      <ContextMenuItem disabled={paused} onClick={() => requestRun(id)} className="text-sm">
        <IconRefresh className="size-4" /> 지금 동기화
      </ContextMenuItem>
      {paused ? (
        <ContextMenuItem
          onClick={() => {
            releaseHold(id);
            updateLink(id, { paused: false });
            requestRun(id); // 엔진이 다시 만들어지기 전이면 무시되고, 마운트 실행이 대신 돈다
          }}
          className="text-sm"
        >
          <IconPlayerPlay className="size-4" /> 다시 시작
        </ContextMenuItem>
      ) : (
        <ContextMenuItem
          onClick={() => {
            releaseHold(id);
            updateLink(id, { paused: true });
          }}
          className="text-sm"
        >
          <IconPlayerPause className="size-4" /> 일시정지
        </ContextMenuItem>
      )}
      <ContextMenuItem disabled={!onUnsync} onClick={() => onUnsync?.(link)} className="text-sm">
        <IconUnlink className="size-4" /> 동기화 해제
      </ContextMenuItem>
    </>
  );
}
