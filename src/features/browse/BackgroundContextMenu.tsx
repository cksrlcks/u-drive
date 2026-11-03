import { IconFolderPlus, IconFolderUp, IconRefresh, IconRefreshDot, IconUpload } from "@tabler/icons-react";
import type { ReactElement, ReactNode } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { modKey } from "@/features/shell/platform";
import type { Sort, SortKey, ViewMode } from "./FileList";

export interface BackgroundMenuActions {
  newFolder(): void;
  upload(): void;
  /** 데스크톱 앱에서만 */
  uploadFolder?(): void;
  /** 데스크톱 앱에서만 */
  addSyncFolder?(): void;
  selectAll(): void;
  refresh(): void;
  view: ViewMode;
  setView(v: ViewMode): void;
  sort: Sort;
  setSort(s: Sort): void;
  /** 읽기 전용 저장소: 새 폴더·업로드를 끈다 */
  readOnly?: boolean;
}

interface Props {
  actions: BackgroundMenuActions;
  /** 트리거로 쓸 요소(파일 목록 영역). 내용은 children으로 */
  trigger: ReactElement;
  children: ReactNode;
  /** 저장소를 고르지 않았거나 이름 입력 중이면 끈다(입력칸은 기본 메뉴로 복사·붙여넣기) */
  disabled?: boolean;
  /** 메뉴가 열릴 때. 탐색기·Finder처럼 선택을 푼다 */
  onOpen?(): void;
}

/** 파일 목록 빈 곳 오른쪽 클릭 메뉴. 항목 위에서는 항목 메뉴(EntryContextMenu)가 이벤트를 먼저 가져간다 */
export function BackgroundContextMenu({ actions: a, trigger, children, disabled, onOpen }: Props) {
  const mod = modKey();
  return (
    <ContextMenu disabled={disabled} onOpenChange={(open) => open && onOpen?.()}>
      <ContextMenuTrigger render={trigger}>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-48">
        <ContextMenuItem disabled={a.readOnly} onClick={a.newFolder} className="text-sm">
          <IconFolderPlus className="size-4" /> 새 폴더
          <ContextMenuShortcut>{mod}+Shift+N</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem disabled={a.readOnly} onClick={a.upload} className="text-sm">
          <IconUpload className="size-4" /> 파일 업로드…
        </ContextMenuItem>
        {a.uploadFolder && (
          <ContextMenuItem disabled={a.readOnly} onClick={a.uploadFolder} className="text-sm">
            <IconFolderUp className="size-4" /> 폴더 업로드…
          </ContextMenuItem>
        )}
        {a.addSyncFolder && (
          <ContextMenuItem disabled={a.readOnly} onClick={a.addSyncFolder} className="text-sm">
            <IconRefreshDot className="size-4" /> 동기화 폴더 추가…
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuSub>
          <ContextMenuSubTrigger inset className="text-sm">보기</ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <ContextMenuRadioGroup value={a.view} onValueChange={(v) => a.setView(v as ViewMode)}>
              <ContextMenuRadioItem value="list" className="text-sm">
                목록
              </ContextMenuRadioItem>
              <ContextMenuRadioItem value="grid" className="text-sm">
                아이콘
              </ContextMenuRadioItem>
            </ContextMenuRadioGroup>
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSub>
          <ContextMenuSubTrigger inset className="text-sm">정렬 기준</ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <ContextMenuRadioGroup value={a.sort.key} onValueChange={(k) => a.setSort({ ...a.sort, key: k as SortKey })}>
              <ContextMenuRadioItem value="name" className="text-sm">
                이름
              </ContextMenuRadioItem>
              <ContextMenuRadioItem value="mtime" className="text-sm">
                수정일
              </ContextMenuRadioItem>
              <ContextMenuRadioItem value="size" className="text-sm">
                크기
              </ContextMenuRadioItem>
            </ContextMenuRadioGroup>
            <ContextMenuSeparator />
            <ContextMenuRadioGroup value={a.sort.dir} onValueChange={(d) => a.setSort({ ...a.sort, dir: d as Sort["dir"] })}>
              <ContextMenuRadioItem value="asc" className="text-sm">
                오름차순
              </ContextMenuRadioItem>
              <ContextMenuRadioItem value="desc" className="text-sm">
                내림차순
              </ContextMenuRadioItem>
            </ContextMenuRadioGroup>
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSeparator />
        <ContextMenuItem inset onClick={a.selectAll} className="text-sm">
          모두 선택
          <ContextMenuShortcut>{mod}+A</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onClick={a.refresh} className="text-sm">
          <IconRefresh className="size-4" /> 새로고침
          <ContextMenuShortcut>F5</ContextMenuShortcut>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
