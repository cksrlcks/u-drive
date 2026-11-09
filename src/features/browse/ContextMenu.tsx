import { IconBuildingBroadcastTower, IconDownload, IconPencil, IconTrash } from "@tabler/icons-react";
import type { ReactNode } from "react";
import { ContextMenu as Root, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuShortcut, ContextMenuTrigger } from "@/components/ui/context-menu";
import { SyncMenuItems } from "@/features/sync/SyncMenuItems";
import type { SyncLink } from "@/features/sync/type";
import type { Entry } from "@/storage/StorageProvider";

export interface EntryMenuActions {
  onOpen(entry: Entry): void;
  onDownload(entry: Entry): void;
  /** 읽기 전용 저장소면 없음(메뉴 항목이 꺼진다) */
  onRename?(entry: Entry): void;
  /** 바로 보내기. 설치된 앱에서만 */
  onNearby?(entry: Entry): void;
  onDelete?(entry: Entry): void;
  /** 연결 폴더면 그 연결(관리 항목이 붙는다). 데스크톱에서만 */
  syncMenu?(entry: Entry): { link: SyncLink } | undefined;
  onUnsync?(link: SyncLink): void;
}

interface Props {
  entry: Entry;
  actions: EntryMenuActions;
  children: ReactNode;
  /** 테이블 행이면 <tr>, 아니면 <div>를 트리거로 */
  asRow?: boolean;
  className?: string;
  onContextMenu?(): void;
  onClick?(e: React.MouseEvent): void;
  onDoubleClick?(): void;
  dataPath?: string;
}

export function EntryContextMenu({ entry, actions, children, asRow, className, onContextMenu, onClick, onDoubleClick, dataPath }: Props) {
  const handlers = { className, onContextMenu, onClick, onDoubleClick, "data-path": dataPath };
  const sync = actions.syncMenu?.(entry);
  const trigger = asRow ? <tr {...handlers} /> : <div {...handlers} />;
  return (
    <Root>
      <ContextMenuTrigger render={trigger}>{children}</ContextMenuTrigger>
      <ContextMenuContent className="min-w-44">
        <ContextMenuItem inset onClick={() => actions.onOpen(entry)} className="text-sm">
          열기
          <ContextMenuShortcut>Enter</ContextMenuShortcut>
        </ContextMenuItem>
        {entry.type === "file" && (
          <ContextMenuItem onClick={() => actions.onDownload(entry)} className="text-sm">
            <IconDownload className="size-4" /> 다운로드
          </ContextMenuItem>
        )}
        <ContextMenuItem disabled={!actions.onRename} onClick={() => actions.onRename?.(entry)} className="text-sm">
          <IconPencil className="size-4" /> 이름 변경
          <ContextMenuShortcut>F2</ContextMenuShortcut>
        </ContextMenuItem>
        {entry.type === "file" && actions.onNearby && (
          <ContextMenuItem onClick={() => actions.onNearby?.(entry)} className="text-sm">
            <IconBuildingBroadcastTower className="size-4" /> 바로 보내기…
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" disabled={!actions.onDelete} onClick={() => actions.onDelete?.(entry)} className="text-sm">
          <IconTrash className="size-4" /> 삭제
          <ContextMenuShortcut>Del</ContextMenuShortcut>
        </ContextMenuItem>
        {sync && <SyncMenuItems link={sync.link} onUnsync={actions.onUnsync} />}
      </ContextMenuContent>
    </Root>
  );
}
