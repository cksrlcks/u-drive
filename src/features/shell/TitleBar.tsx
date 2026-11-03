import { IconArrowUp, IconChevronLeft, IconChevronRight, IconFolderPlus, IconLayoutGrid, IconLayoutSidebarRight, IconList, IconRefresh, IconRefreshDot, IconUpload } from "@tabler/icons-react";
import { cn } from "cn";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { CloudMark } from "@/components/ui/cloud-mark";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { SearchBox } from "@/features/search/SearchBox";
import type { Entry } from "@/storage/StorageProvider";
import { MenuBar, type MenuActions } from "./MenuBar";
import { isMac, isTauri, modKey, showWindowControls } from "./platform";
import { WindowControls } from "./WindowControls";

export interface Crumb {
  label: string;
  path: string;
}

interface Props {
  menu: MenuActions;
  crumbs: Crumb[];
  onNavigate(path: string): void;
  onSearchPick(libId: string, entry: Entry): void;
  disabled?: boolean;
}

/**
 * 창 상단 두 줄: [메뉴바 + 드래그 영역 + 창 버튼] / [툴바].
 * VS Code·Windows Files 앱과 같은 구조. 빈 영역은 창 드래그.
 */
export function TitleBar({ menu: m, crumbs, onNavigate, onSearchPick, disabled }: Props) {
  const drag = isTauri() ? { "data-tauri-drag-region": true } : {};
  return (
    <div className="shrink-0 select-none border-b border-border bg-titlebar">
      {/* 1줄: 메뉴바 */}
      <div {...drag} className={cn("flex h-8 items-center", isMac() && isTauri() ? "pl-20" : "pl-1")}>
        <MenuBar {...m} />
        <div {...drag} className="h-full flex-1" />
        {showWindowControls() && <WindowControls />}
      </div>

      {/* 2줄: 툴바 */}
      <div {...drag} className="flex h-9 items-center gap-1 px-1.5 pb-1">
        <IconBtn label="뒤로" shortcut="Alt+←" onClick={m.back} disabled={!m.canBack}>
          <IconChevronLeft className="size-4" stroke={1.75} />
        </IconBtn>
        <IconBtn label="앞으로" shortcut="Alt+→" onClick={m.forward} disabled={!m.canForward}>
          <IconChevronRight className="size-4" stroke={1.75} />
        </IconBtn>
        <IconBtn label="위로" shortcut="Backspace" onClick={m.up} disabled={!m.canUp}>
          <IconArrowUp className="size-4" stroke={1.75} />
        </IconBtn>

        <div {...drag} className="mx-1 flex h-7 min-w-0 flex-1 items-center gap-0.5 overflow-hidden rounded-md border border-border bg-background px-1.5 text-sm">
          <CloudMark className="mr-1 size-4 shrink-0" />
          {crumbs.map((c, i) => {
            const last = i === crumbs.length - 1;
            return (
              <span key={c.path} className="flex min-w-0 items-center">
                {i > 0 && <IconChevronRight className="mx-0.5 size-3.5 shrink-0 text-muted-foreground" stroke={1.75} />}
                {last ? (
                  <span className="truncate font-medium">{c.label}</span>
                ) : (
                  <button type="button" onClick={() => onNavigate(c.path)} className="truncate rounded px-1 text-foreground/80 hover:bg-accent">
                    {c.label}
                  </button>
                )}
              </span>
            );
          })}
        </div>

        <SearchBox onPick={onSearchPick} disabled={disabled} />

        <div className="mx-1 flex h-7 shrink-0 items-center rounded-md border border-border bg-background p-0.5">
          <IconBtn label="목록" onClick={() => m.setView("list")} active={m.view === "list"} size="xs">
            <IconList className="size-3.5" stroke={1.75} />
          </IconBtn>
          <IconBtn label="아이콘" onClick={() => m.setView("grid")} active={m.view === "grid"} size="xs">
            <IconLayoutGrid className="size-3.5" stroke={1.75} />
          </IconBtn>
        </div>
        <IconBtn label="세부 정보 창" onClick={m.toggleDetails} active={m.detailsOpen}>
          <IconLayoutSidebarRight className="size-4" stroke={1.75} />
        </IconBtn>

        <IconBtn label="새로고침" shortcut="F5" onClick={m.refresh} disabled={disabled}>
          <IconRefresh className="size-4" stroke={1.75} />
        </IconBtn>
        <IconBtn label="새 폴더" shortcut={`${modKey()}+Shift+N`} onClick={m.newFolder} disabled={disabled || m.readOnly}>
          <IconFolderPlus className="size-4" stroke={1.75} />
        </IconBtn>
        {m.addSyncFolder && (
          <IconBtn label="동기화 폴더 추가" onClick={m.addSyncFolder} disabled={disabled || m.readOnly}>
            <IconRefreshDot className="size-4" stroke={1.75} />
          </IconBtn>
        )}
        <Button size="sm" onClick={m.upload} disabled={disabled || m.readOnly} className="mx-1 h-7 rounded-md px-2.5">
          <IconUpload className="size-3.5" stroke={2} /> 업로드
        </Button>

      </div>
    </div>
  );
}

function IconBtn({ label, shortcut, onClick, disabled, active, size = "sm", children }: { label: string; shortcut?: string; onClick(): void; disabled?: boolean; active?: boolean; size?: "sm" | "xs"; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size={size === "xs" ? "icon-xs" : "icon-sm"}
            onClick={onClick}
            disabled={disabled}
            aria-label={label}
            className={cn("rounded-md text-foreground/80", size === "xs" ? "size-6" : "size-7", active && "bg-accent text-foreground")}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>
        {label}
        {shortcut && <span className="ml-2 opacity-60">{shortcut}</span>}
      </TooltipContent>
    </Tooltip>
  );
}
