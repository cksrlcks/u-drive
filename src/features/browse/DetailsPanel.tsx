import { CloudMark } from "@/components/ui/cloud-mark";
import { FolderGlyph } from "@/components/ui/folder-glyph";
import { SyncDetails } from "@/features/sync/SyncDetails";
import type { SyncLink } from "@/features/sync/type";
import { formatDate, formatSize } from "@/lib/format";
import { parentPath } from "@/storage/path";
import type { Entry } from "@/storage/StorageProvider";
import { EntryIcon } from "./FileList";
import { useThumbnail } from "./useThumbnail";

interface Props {
  libId: string | null;
  libName: string;
  /** 아무것도 선택 안 했을 때 보여 줄 현재 폴더 */
  folderName: string;
  /** 현재 폴더가 드라이브 맨 위면 폴더 그림에 구름 배지 */
  root: boolean;
  entries: Entry[];
  selected: Entry[];
  sharedPaths?: Set<string>;
  syncLinks?: Map<string, SyncLink>;
}

/** 탐색기 "세부 정보 창": 선택 하나면 미리보기+속성, 여럿이면 개수·합계, 없으면 현재 폴더 요약 */
export function DetailsPanel({ libId, libName, folderName, root, entries, selected, sharedPaths, syncLinks }: Props) {
  return (
    <aside className="flex w-70 shrink-0 flex-col gap-4 overflow-y-auto border-l border-border bg-sidebar p-4 text-sm">
      {selected.length === 1 ? (
        <Single libId={libId} libName={libName} entry={selected[0]} shared={!!sharedPaths?.has(selected[0].path)} sync={syncLinks?.get(selected[0].path)} />
      ) : selected.length > 1 ? (
        <Summary title={`${selected.length}개 항목 선택됨`} items={selected} />
      ) : (
        <Summary title={folderName} items={entries} drive={root} />
      )}
    </aside>
  );
}

function Single({ libId, libName, entry, shared, sync }: { libId: string | null; libName: string; entry: Entry; shared: boolean; sync?: SyncLink }) {
  const [ref, thumb] = useThumbnail(libId, entry, 256);
  const dir = entry.type === "dir";
  const ext = !dir && entry.name.includes(".") ? entry.name.split(".").pop()!.toUpperCase() : "";
  const parent = parentPath(entry.path);
  return (
    <>
      <div ref={ref} className="flex h-40 items-center justify-center rounded-lg bg-background">
        {thumb ? (
          <img src={thumb} alt="" draggable={false} className="max-h-36 max-w-60 rounded-sm object-contain shadow-item" />
        ) : (
          <EntryIcon entry={entry} size={48} className="size-16" fallback={dir ? <FolderGlyph className="size-20" /> : undefined} />
        )}
      </div>
      <div className="font-medium break-all">{entry.name}</div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs">
        <Row label="종류">{dir ? "폴더" : ext ? `${ext} 파일` : "파일"}</Row>
        {!dir && <Row label="크기">{formatSize(entry.size)}</Row>}
        <Row label="수정한 날짜">{formatDate(entry.mtime)}</Row>
        <Row label="위치">{parent === "/" ? libName : `${libName}${parent}`}</Row>
        <Row label="공유 링크">{shared ? "있음" : "없음"}</Row>
      </dl>
      {sync && <SyncDetails link={sync} />}
    </>
  );
}

function Summary({ title, items, drive }: { title: string; items: Entry[]; drive?: boolean }) {
  const dirs = items.filter((e) => e.type === "dir").length;
  const files = items.length - dirs;
  return (
    <>
      <div className="flex h-40 items-center justify-center rounded-lg bg-background">
        <span className="relative flex">
          <FolderGlyph className="size-20" />
          {drive && (
            <span className="absolute right-0 bottom-2 flex size-8 items-center justify-center rounded-full bg-card shadow-item" aria-label="드라이브">
              <CloudMark className="size-5" />
            </span>
          )}
        </span>
      </div>
      <div className="font-medium break-all">{title}</div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs">
        <Row label="항목">{[dirs && `폴더 ${dirs}개`, files && `파일 ${files}개`].filter(Boolean).join(", ") || "없음"}</Row>
        {files > 0 && <Row label="파일 크기">{formatSize(items.reduce((a, e) => a + (e.type === "file" ? e.size : 0), 0))}</Row>}
      </dl>
    </>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-all">{children}</dd>
    </>
  );
}
