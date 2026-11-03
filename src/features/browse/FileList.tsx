import { IconArrowDown, IconArrowUp, IconFile, IconFileZip, IconFileMusic, IconCode, IconLink, IconPhoto, IconFileSpreadsheet, IconFileText, IconMovie, IconFolder } from "@tabler/icons-react";
import { cn } from "cn";
import type { ReactNode } from "react";
import { SyncBadge } from "@/features/sync/SyncBadge";
import { useAllLinkStates } from "@/features/sync/syncState";
import type { SyncLink } from "@/features/sync/type";
import { formatDateLong, formatSize } from "@/lib/format";
import type { Entry } from "@/storage/StorageProvider";
import { EntryContextMenu, type EntryMenuActions } from "./ContextMenu";
import { InlineName } from "./InlineName";
import { uniqueName } from "./validateName";
import { useColumnWidths, type ColKey } from "./useColumnWidths";
import { useShellIcon } from "./useShellIcon";

export type ViewMode = "list" | "grid";
export type SortKey = "name" | "mtime" | "size";
export interface Sort {
  key: SortKey;
  dir: "asc" | "desc";
}

/** 폴더 먼저(이름순), 파일은 정렬 기준대로 — Finder/탐색기 관례 */
export function orderEntries(list: Entry[], sort: Sort): Entry[] {
  const m = sort.dir === "asc" ? 1 : -1;
  const cmp = (a: Entry, b: Entry) => (sort.key === "name" ? a.name.localeCompare(b.name) * m : (a[sort.key] - b[sort.key]) * m);
  const dirs = list.filter((e) => e.type === "dir").sort((a, b) => a.name.localeCompare(b.name) * (sort.key === "name" ? m : 1));
  const files = list.filter((e) => e.type === "file").sort(cmp);
  return [...dirs, ...files];
}

const ICONS: Record<string, typeof IconFile> = {
  png: IconPhoto, jpg: IconPhoto, jpeg: IconPhoto, gif: IconPhoto, webp: IconPhoto, svg: IconPhoto, bmp: IconPhoto, heic: IconPhoto,
  mp4: IconMovie, mov: IconMovie, mkv: IconMovie, avi: IconMovie, webm: IconMovie,
  mp3: IconFileMusic, wav: IconFileMusic, flac: IconFileMusic, m4a: IconFileMusic,
  zip: IconFileZip, "7z": IconFileZip, rar: IconFileZip, tar: IconFileZip, gz: IconFileZip,
  xlsx: IconFileSpreadsheet, xls: IconFileSpreadsheet, csv: IconFileSpreadsheet,
  txt: IconFileText, md: IconFileText, pdf: IconFileText, doc: IconFileText, docx: IconFileText, hwp: IconFileText,
  js: IconCode, ts: IconCode, tsx: IconCode, jsx: IconCode, py: IconCode, rs: IconCode, go: IconCode, json: IconCode, html: IconCode, css: IconCode, sh: IconCode,
};

/** 공유 링크가 있는 항목의 아이콘 모서리 배지(탐색기의 공유 오버레이처럼) */
export function SharedBadge({ className }: { className?: string }) {
  return (
    <span className={cn("absolute flex size-4 items-center justify-center rounded-full bg-card shadow-item", className)} aria-label="공유 링크 있음">
      <IconLink className="size-2.5 text-primary" stroke={2.5} />
    </span>
  );
}

/** 상위 폴더("...") 항목의 폴더 아이콘 모서리 배지. 채운 원 안에 위 화살표 */
export function UpBadge({ className, iconClassName }: { className?: string; iconClassName?: string }) {
  return (
    <span className={cn("absolute flex items-center justify-center rounded-full bg-primary text-primary-foreground shadow-item", className)}>
      <IconArrowUp className={iconClassName} stroke={3} />
    </span>
  );
}

/** 새 폴더 입력 줄·상위 폴더 항목의 아이콘용. 셸 아이콘은 종류·이름만 보므로 나머지는 빈 값 */
export const NEW_FOLDER_ENTRY: Entry = { id: "", name: "", type: "dir", size: 0, mtime: 0, path: "" };

/**
 * Tauri(윈도우·맥)면 셸 아이콘(img), 아니면 SVG. 셸 아이콘을 받는 동안엔 같은 크기의 빈 자리만 둬서 SVG가 잠깐 비치지 않게.
 * fallback은 셸 아이콘이 없을 때 폴더 대신 그릴 것(그리드의 FolderGlyph)
 */
export function EntryIcon({ entry, className, size = 16, fallback }: { entry: Entry; className?: string; size?: 16 | 48; fallback?: ReactNode }) {
  const shell = useShellIcon(entry, size);
  if (shell.src) return <img src={shell.src} alt="" draggable={false} className={cn("size-4 shrink-0", className)} />;
  if (shell.pending) return <span aria-hidden className={cn("size-4 shrink-0", className)} />;
  if (fallback) return <>{fallback}</>;
  if (entry.type === "dir") return <IconFolder className={cn("size-4 fill-primary/20 text-primary", className)} />;
  const ext = entry.name.split(".").pop()?.toLowerCase() ?? "";
  const Icon = ICONS[ext] ?? IconFile;
  return <Icon className={cn("size-4 text-muted-foreground", className)} stroke={1.75} />;
}

export interface ListProps {
  entries: Entry[];
  /** 공유 링크가 있는 항목의 경로. 이름 옆(목록)·아이콘 모서리(그리드)에 표시 */
  sharedPaths?: Set<string>;
  /** 동기화 폴더의 드라이브 경로 → 연결(지금 저장소만). 폴더 아이콘에 배지 */
  syncLinks?: Map<string, SyncLink>;
  sort: Sort;
  onSort(key: SortKey): void;
  selected: Set<string>;
  focusPath: string | null;
  onSelect(entry: Entry, e: React.MouseEvent): void;
  onOpen(entry: Entry): void;
  actions: EntryMenuActions;
  existingNames: string[];
  renamingPath: string | null;
  onRenameSubmit(entry: Entry, newName: string): void;
  onRenameCancel(): void;
  creatingFolder: boolean;
  onCreateFolder(name: string): void;
  onCreateFolderCancel(): void;
  /** 끌어 옮기는 중 지금 놓을 폴더 */
  dropTarget?: string | null;
  /** 하위 폴더면 맨 위 "..." 항목의 경로. 더블클릭하면 올라가고, 끌어다 놓으면 상위 폴더로 옮긴다. 선택·정렬 대상은 아니다 */
  parentDir?: string | null;
  onOpenParent?(): void;
}

/** 표 보기: 24px 머리글, 28px 행, 줄무늬, 전체 행 선택 */
export function FileList(p: ListProps) {
  const states = useAllLinkStates();
  const { widths, startResize } = useColumnWidths<ColKey>("seadrive.columns", { mtime: 176, size: 96 }, { mtime: 90, size: 64 });
  return (
    <table className="w-full table-fixed border-collapse text-sm">
      <colgroup>
        <col />
        <col style={{ width: 32 }} />
        <col style={{ width: widths.mtime }} />
        <col style={{ width: widths.size }} />
      </colgroup>
      <thead className="sticky top-0 z-10 bg-background">
        <tr className="h-7 border-b border-border text-2xs text-muted-foreground">
          <Th label="이름" k="name" sort={p.sort} onSort={p.onSort} className="pl-3" />
          <th aria-label="공유" className="relative">
            {/* 열 조절 핸들은 공유 열 오른쪽(수정일 앞)에 둔다 */}
            <span role="separator" aria-orientation="vertical" onPointerDown={(e) => startResize("mtime", e)} className="group absolute top-0 right-0 bottom-0 z-20 w-2 translate-x-1/2 cursor-col-resize">
              <span className="absolute top-1.5 bottom-1.5 left-1/2 w-px bg-border group-hover:bg-primary" />
            </span>
          </th>
          <Th label="수정일" k="mtime" sort={p.sort} onSort={p.onSort} className="pl-3" resize="size" onResize={startResize} />
          <Th label="크기" k="size" sort={p.sort} onSort={p.onSort} className="pr-3 pl-3 text-right" />
        </tr>
      </thead>
      <tbody>
        {p.parentDir != null && (
          <tr data-drop={p.parentDir} title="상위 폴더" onDoubleClick={p.onOpenParent} className={cn("h-8.5 cursor-default select-none", p.dropTarget === p.parentDir && "bg-primary/10 outline-2 -outline-offset-2 outline-primary")}>
            <td className="pl-3" colSpan={4}>
              <span className="flex items-center gap-2">
                <span className="relative shrink-0">
                  <EntryIcon entry={NEW_FOLDER_ENTRY} />
                  <UpBadge className="-right-1 -bottom-0.5 size-2.5" iconClassName="size-2" />
                </span>
                ...
              </span>
            </td>
          </tr>
        )}
        {p.creatingFolder && (
          <tr className="h-8.5">
            <td className="pl-3" colSpan={4}>
              <span className="flex items-center gap-2">
                <EntryIcon entry={NEW_FOLDER_ENTRY} />
                <InlineName initial={uniqueName("새 폴더", p.existingNames)} existing={p.existingNames} create onSubmit={p.onCreateFolder} onCancel={p.onCreateFolderCancel} className="h-6 max-w-xs text-sm md:text-sm" />
              </span>
            </td>
          </tr>
        )}
        {p.entries.map((e, i) => {
          const sel = p.selected.has(e.path);
          return (
            <EntryContextMenu
              key={e.path}
              entry={e}
              actions={p.actions}
              asRow
              dataPath={e.path}
              className={cn(
                "h-8.5 cursor-default select-none",
                (i + (p.parentDir != null ? 1 : 0)) % 2 === 1 && !sel && "bg-muted/60", // "..." 줄까지 이어서 줄무늬
                sel && "bg-selection",
                p.focusPath === e.path && "outline-1 -outline-offset-1 outline-primary/60",
                p.dropTarget === e.path && "bg-primary/10 outline-2 -outline-offset-2 outline-primary",
              )}
              onClick={(ev) => p.onSelect(e, ev)}
              onDoubleClick={() => p.renamingPath !== e.path && p.onOpen(e)}
              onContextMenu={() => !sel && p.onSelect(e, { ctrlKey: false, metaKey: false, shiftKey: false } as React.MouseEvent)}
            >
              <td className="pl-3">
                {/* 아이콘·이름 부분만 끌어 옮기기 손잡이(useDragMove). 나머지 빈 곳은 드래그 선택 */}
                <span data-drag className={cn("flex items-center gap-2", p.renamingPath !== e.path && "w-fit max-w-full")}>
                  <span className="relative flex">
                    <EntryIcon entry={e} />
                    {p.syncLinks?.get(e.path) && <SyncBadge status={states[p.syncLinks.get(e.path)!.id]?.status ?? "idle"} className="-right-1 -bottom-1 size-3" />}
                  </span>
                  {p.renamingPath === e.path ? (
                    <InlineName initial={e.name} existing={p.existingNames.filter((n) => n !== e.name)} onSubmit={(n) => p.onRenameSubmit(e, n)} onCancel={p.onRenameCancel} className="h-6 max-w-sm text-sm md:text-sm" />
                  ) : (
                    <span className="truncate">{e.name}</span>
                  )}
                </span>
              </td>
              <td>
                {p.sharedPaths?.has(e.path) && (
                  <span className="flex items-center justify-center">
                    <IconLink className="size-4 text-success" stroke={2} aria-label="공유 링크 있음" />
                  </span>
                )}
              </td>
              <td className="truncate pl-3 text-muted-foreground">{formatDateLong(e.mtime)}</td>
              <td className="truncate pr-3 pl-3 text-right text-muted-foreground tabular-nums">{e.type === "file" ? formatSize(e.size) : ""}</td>
            </EntryContextMenu>
          );
        })}
      </tbody>
    </table>
  );
}

/** 머리글 셀. resize가 있으면 오른쪽 경계를 끌어 "다음 열"의 너비를 조절한다(탐색기와 같은 방식). */
function Th({ label, k, sort, onSort, className, resize, onResize }: { label: string; k: SortKey; sort: Sort; onSort(k: SortKey): void; className?: string; resize?: ColKey; onResize?(key: ColKey, e: React.PointerEvent): void }) {
  const active = sort.key === k;
  return (
    <th className={cn("relative cursor-default overflow-hidden text-left font-normal whitespace-nowrap select-none hover:bg-accent", className)} onClick={() => onSort(k)}>
      <span className="inline-flex max-w-full items-center gap-1 truncate">
        {label}
        {active && (sort.dir === "asc" ? <IconArrowUp className="size-3" /> : <IconArrowDown className="size-3" />)}
      </span>
      {resize && (
        <span
          role="separator"
          aria-orientation="vertical"
          onPointerDown={(e) => onResize?.(resize, e)}
          onClick={(e) => e.stopPropagation()}
          className="group absolute top-0 right-0 bottom-0 z-20 w-2 translate-x-1/2 cursor-col-resize"
        >
          <span className="absolute top-1.5 bottom-1.5 left-1/2 w-px bg-border group-hover:bg-primary" />
        </span>
      )}
    </th>
  );
}

export function FileListSkeleton() {
  return (
    <div className="flex flex-col">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className={cn("h-8.5", i % 2 === 1 && "bg-muted/60")}>
          <div className="ml-3 mt-2.5 h-3.5 w-48 animate-pulse rounded bg-muted" />
        </div>
      ))}
    </div>
  );
}
