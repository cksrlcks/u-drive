import { cn } from "cn";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { FolderGlyph } from "@/components/ui/folder-glyph";
import { EntryContextMenu } from "./ContextMenu";
import { SyncBadge } from "@/features/sync/SyncBadge";
import type { Entry } from "@/storage/StorageProvider";
import { EntryIcon, NEW_FOLDER_ENTRY, UpBadge, type ListProps } from "./FileList";
import { InlineName } from "./InlineName";
import { useThumbnail } from "./useThumbnail";
import { uniqueName } from "./validateName";
import { useWindow } from "./useWindow";

/**
 * 아이콘 크기 단계(작게·보통·크게·아주 크게). Ctrl+휠로 바꾼다.
 * 셸 아이콘은 48px까지만 받아서 큰 단계에서도 size-16에서 멈추고, 썸네일·폴더 그림만 끝까지 커진다.
 * row는 칸 높이(px) = 위아래 p-2(16) + box + gap-1(4) + 두 줄 라벨(12px×1.25×2 = 30). 줄 높이가 같아야 화면 근처 줄만 그릴 수 있다
 */
export const ICON_SIZES = [
  { cell: 84, box: "h-12", row: 98, icon: "size-10", glyph: "size-12", thumb: "max-h-12 max-w-16", px: 128 },
  { cell: 104, box: "h-16", row: 114, icon: "size-12", glyph: "size-16", thumb: "max-h-16 max-w-20", px: 128 },
  { cell: 140, box: "h-24", row: 146, icon: "size-14", glyph: "size-24", thumb: "max-h-24 max-w-30", px: 256 },
  { cell: 196, box: "h-36", row: 194, icon: "size-16", glyph: "size-36", thumb: "max-h-36 max-w-44", px: 256 },
] as const;
type IconSize = (typeof ICON_SIZES)[number];
const PAD = 12; // p-3
const GAP = 4; // gap-1

/** 아이콘 보기: 크기 단계별 셀, 12px 두 줄 라벨. 화면 근처 줄만 그리고 나머지는 위아래 여백으로 채운다 */
export function IconGrid(p: ListProps & { libId: string | null; iconSize: number }) {
  const s = ICON_SIZES[p.iconSize] ?? ICON_SIZES[1];
  // 열 개수는 auto-fill이 정한다. 너비·크기 단계가 바뀔 때마다 계산된 열을 읽는다
  const gridRef = useRef<HTMLDivElement>(null);
  const [cols, setCols] = useState(1);
  useLayoutEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const update = () => setCols(getComputedStyle(el).gridTemplateColumns.split(" ").length);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [s.cell]);

  // 상위 폴더·새 폴더 칸이 entries 앞에 온다
  const lead: ("parent" | "new")[] = [];
  if (p.parentDir != null) lead.push("parent");
  if (p.creatingFolder) lead.push("new");
  const total = lead.length + p.entries.length;
  const rows = Math.ceil(total / cols);
  const stride = s.row + GAP;
  const win = useWindow(p.scrollRef, rows, PAD, stride, 3);
  useEffect(() => {
    const i = p.entries.findIndex((e) => e.path === p.focusPath);
    if (i >= 0) win.reveal(Math.floor((lead.length + i) / cols));
  }, [p.focusPath]);

  const from = win.start * cols;
  const to = Math.min(total, win.end * cols);
  return (
    <div
      ref={gridRef}
      className="grid gap-1 px-3"
      style={{ gridTemplateColumns: `repeat(auto-fill,minmax(${s.cell}px,1fr))`, gridAutoRows: s.row, paddingTop: PAD + win.start * stride, paddingBottom: PAD + (rows - win.end) * stride }}
    >
      {Array.from({ length: to - from }, (_, k) => from + k).map((i) => (i < lead.length ? lead[i] : p.entries[i - lead.length])).map((cell) => {
        if (cell === "parent") return (
        <div
          key="parent"
          data-drop={p.parentDir!}
          title="상위 폴더"
          onDoubleClick={p.onOpenParent}
          className={cn("flex cursor-default flex-col items-center gap-1 rounded-md p-2 select-none hover:bg-accent/60", p.dropTarget === p.parentDir && "bg-primary/10 outline-2 -outline-offset-2 outline-primary")}
        >
          <div className={cn("flex items-center justify-center", s.box)}>
            {/* 배지는 칸이 아니라 아이콘 모서리에 붙인다(셸 아이콘은 칸보다 훨씬 작다) */}
            <span className="relative flex">
              <EntryIcon entry={NEW_FOLDER_ENTRY} size={48} className={s.icon} fallback={<FolderGlyph className={s.glyph} />} />
              <UpBadge className="-right-1 bottom-0 size-5" iconClassName="size-3" />
            </span>
          </div>
          <span className="text-xs leading-tight">...</span>
        </div>
        );
        if (cell === "new") return (
        <div key="new" className="flex flex-col items-center gap-1 rounded-md p-2">
          <div className={cn("flex items-center justify-center", s.box)}>
            <EntryIcon entry={NEW_FOLDER_ENTRY} size={48} className={s.icon} fallback={<FolderGlyph className={s.glyph} />} />
          </div>
          <InlineName initial={uniqueName("새 폴더", p.existingNames)} existing={p.existingNames} create onSubmit={p.onCreateFolder} onCancel={p.onCreateFolderCancel} className="h-6 text-center text-xs md:text-xs" />
        </div>
        );
        const e = cell;
        const sel = p.selected.has(e.path);
        return (
          <EntryContextMenu
            key={e.path}
            entry={e}
            actions={p.actions}
            dataPath={e.path}
            className={cn(
              "flex cursor-default flex-col items-center gap-1 rounded-md p-2 select-none",
              sel ? "bg-selection" : "hover:bg-accent/60",
              p.focusPath === e.path && "outline-1 -outline-offset-1 outline-primary/60",
              p.dropTarget === e.path && "bg-primary/10 outline-2 -outline-offset-2 outline-primary",
            )}
            onClick={(ev) => p.onSelect(e, ev)}
            onDoubleClick={() => p.renamingPath !== e.path && p.onOpen(e)}
            onContextMenu={() => !sel && p.onSelect(e, { ctrlKey: false, metaKey: false, shiftKey: false } as React.MouseEvent)}
          >
            <GridIcon libId={p.libId} entry={e} syncId={p.syncLinks?.get(e.path)?.id} s={s} />
            {p.renamingPath === e.path ? (
              <InlineName initial={e.name} existing={p.existingNames.filter((n) => n !== e.name)} onSubmit={(n) => p.onRenameSubmit(e, n)} onCancel={p.onRenameCancel} className="h-6 text-center text-xs md:text-xs" />
            ) : (
              <span data-drag className="line-clamp-2 w-full text-center text-xs leading-tight break-all" title={e.name}>
                {e.name}
              </span>
            )}
          </EntryContextMenu>
        );
      })}
    </div>
  );
}

/** 이미지면 썸네일, 아니면(또는 받는 중이면) 셸 아이콘 */
function GridIcon({ libId, entry, syncId, s }: { libId: string | null; entry: Entry; syncId?: string; s: IconSize }) {
  const [ref, thumb] = useThumbnail(libId, entry, s.px);
  return (
    <div ref={ref} data-drag className={cn("relative flex items-center justify-center", s.box)}>
      {thumb ? (
        <img src={thumb} alt="" draggable={false} className={cn("rounded-sm object-contain shadow-item", s.thumb)} />
      ) : (
        <EntryIcon entry={entry} size={48} className={s.icon} fallback={entry.type === "dir" ? <FolderGlyph className={s.glyph} /> : undefined} />
      )}
      {syncId && <SyncBadge linkId={syncId} className="bottom-1 left-3" />}
    </div>
  );
}
