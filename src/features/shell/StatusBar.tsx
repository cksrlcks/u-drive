import { useQuery } from "@tanstack/react-query";
import { Progress } from "@/components/ui/progress";
import { formatSize } from "@/lib/format";
import { useStorage } from "@/storage/StorageContext";

interface Props {
  itemCount: number | null;
  /** 검색 중 등 항목 수 대신 보여 줄 문구 */
  note?: string;
  /** 있으면 note를 누를 수 있다 */
  onNoteClick?(): void;
  selectedCount: number;
  selectedBytes: number;
}

/** Finder/탐색기식 하단 상태 표시줄 24px */
export function StatusBar({ itemCount, note, onNoteClick, selectedCount, selectedBytes }: Props) {
  const storage = useStorage();
  const acc = useQuery({ queryKey: ["account"], queryFn: () => storage.getAccount(), staleTime: 30_000 });
  const a = acc.data;
  return (
    <div className="flex h-6 shrink-0 items-center gap-4 border-t border-border bg-sidebar px-3 text-2xs text-muted-foreground">
      {onNoteClick ? (
        <button type="button" onClick={onNoteClick} className="truncate hover:text-foreground">
          {note}
        </button>
      ) : (
        <span className="truncate">{note ?? (itemCount === null ? "" : `${itemCount}개 항목`)}</span>
      )}
      {selectedCount > 0 && (
        <span className="text-foreground">
          {selectedCount}개 선택{selectedBytes > 0 && ` · ${formatSize(selectedBytes)}`}
        </span>
      )}
      <span className="flex-1" />
      {a && (
        <span className="flex items-center gap-2">
          {a.quota ? (
            <>
              <Progress value={Math.max(1.5, Math.min(100, (a.usage / a.quota) * 100))} className="w-24 [&_[data-slot=progress-track]]:h-1.5 [&_[data-slot=progress-track]]:bg-foreground/15" />
              <span>
                {formatSize(a.usage)} / {formatSize(a.quota)} 사용
              </span>
            </>
          ) : (
            <span>{formatSize(a.usage)} 사용</span>
          )}
        </span>
      )}
    </div>
  );
}
