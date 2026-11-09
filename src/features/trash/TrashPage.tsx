import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { IconRestore, IconTrash } from "@tabler/icons-react";
import { cn } from "cn";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EntryIcon } from "@/features/browse/FileList";
import { formatDateLong, formatSize } from "@/lib/format";
import { useStorage } from "@/storage/StorageContext";
import { joinPath } from "@/storage/path";
import type { TrashEntry } from "@/storage/StorageProvider";

/**
 * 현재 저장소의 휴지통 페이지(사이드바 하단 메뉴).
 * 복구하면 원래 폴더로 돌아간다. 항목별 영구 삭제는 서버가 지원하지 않아 전체 비우기만 있다(확인창).
 */
export function TrashPage({ libId, readOnly }: { libId: string; readOnly: boolean }) {
  const storage = useStorage();
  const qc = useQueryClient();
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const trash = useQuery({ queryKey: ["trash", libId], queryFn: () => storage.listTrash(libId) });
  const changed = () => {
    void qc.invalidateQueries({ queryKey: ["trash", libId] });
    void qc.invalidateQueries({ queryKey: ["dir", libId] });
    void qc.invalidateQueries({ queryKey: ["account"] });
    void qc.invalidateQueries({ queryKey: ["libraries"] });
  };
  const restore = useMutation({ mutationFn: (e: TrashEntry) => storage.restoreTrash(libId, e), onSuccess: changed });
  const empty = useMutation({
    mutationFn: () => storage.emptyTrash(libId),
    onSuccess: () => {
      setConfirmEmpty(false);
      changed();
    },
  });
  const items = trash.data ?? [];
  const error = restore.error ?? empty.error;

  const notice = (text: string, tone?: "error") => (
    <tr>
      <td colSpan={5} className={cn("py-10 text-center text-xs", tone === "error" ? "text-destructive" : "text-muted-foreground")}>
        {text}
      </td>
    </tr>
  );

  return (
    <>
      <div className="flex h-10 shrink-0 items-center justify-between gap-3 border-b border-border px-3 text-xs text-muted-foreground">
        <span className="truncate">{readOnly ? "읽기 전용 저장소라 복구하거나 비울 수 없습니다" : "삭제한 항목을 원래 폴더로 복구할 수 있습니다"}</span>
        <Button variant="outline" size="sm" onClick={() => setConfirmEmpty(true)} disabled={readOnly || items.length === 0 || empty.isPending} className="shrink-0">
          <IconTrash className="size-4" /> 비우기
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full table-fixed border-collapse text-sm">
          <colgroup>
            <col />
            <col style={{ width: 200 }} />
            <col style={{ width: 160 }} />
            <col style={{ width: 80 }} />
            <col style={{ width: 84 }} />
          </colgroup>
          <thead className="sticky top-0 z-10 bg-background">
            <tr className="h-7 border-b border-border text-2xs text-muted-foreground">
              <th className="pl-3 text-left font-normal">이름</th>
              <th className="pl-3 text-left font-normal">원래 위치</th>
              <th className="pl-3 text-left font-normal">삭제한 날짜</th>
              <th className="pl-3 text-right font-normal">크기</th>
              <th className="pr-3" />
            </tr>
          </thead>
          <tbody>
            {trash.isLoading
              ? notice("불러오는 중…")
              : trash.error
                ? notice("휴지통을 불러오지 못했습니다", "error")
                : items.length === 0
                  ? notice("휴지통이 비어 있습니다")
                  : items.map((e, i) => (
                      <tr key={`${e.commitId}:${e.parentDir}/${e.name}`} className={cn("h-9 cursor-default select-none hover:bg-accent/50", i % 2 === 1 && "bg-muted/60")}>
                        <td className="pl-3">
                          <span className="flex items-center gap-2">
                            <EntryIcon entry={{ id: e.name, name: e.name, type: e.type, size: e.size, mtime: e.deletedAt, path: joinPath(e.parentDir, e.name) }} />
                            <span className="truncate">{e.name}</span>
                          </span>
                        </td>
                        <td className="truncate pl-3 text-muted-foreground">{e.parentDir}</td>
                        <td className="truncate pl-3 text-muted-foreground">{formatDateLong(e.deletedAt)}</td>
                        <td className="pl-3 text-right text-muted-foreground tabular-nums">{e.type === "file" ? formatSize(e.size) : ""}</td>
                        <td className="pr-3 pl-3 text-right">
                          <Button variant="ghost" size="sm" onClick={() => restore.mutate(e)} disabled={readOnly || restore.isPending}>
                            <IconRestore className="size-3.5" /> 복구
                          </Button>
                        </td>
                      </tr>
                    ))}
          </tbody>
        </table>
        {error && <p className="px-3 py-2 text-xs text-destructive">{error.message}</p>}
      </div>

      <Dialog open={confirmEmpty} onOpenChange={(o) => !o && setConfirmEmpty(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>휴지통을 비울까요?</DialogTitle>
            <DialogDescription>휴지통의 항목 {items.length}개가 영구히 삭제되며 되돌릴 수 없습니다.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmEmpty(false)}>
              취소
            </Button>
            <Button variant="destructive" onClick={() => empty.mutate()} disabled={empty.isPending}>
              비우기
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
