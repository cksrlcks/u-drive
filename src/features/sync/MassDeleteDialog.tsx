import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { holdLink, isHeld, requestRun, useAllLinkStates } from "./syncState";
import type { SyncLink } from "./type";

/** 대량 삭제 확인이 필요한 연결을 하나씩 묻는다. 창이 보일 때만, 취소한 연결은 보류되어 사용자가 다시 시작할 때까지 자동 실행도 멈춘다 */
export function MassDeleteDialog({ links }: { links: SyncLink[] }) {
  const states = useAllLinkStates();
  const [visible, setVisible] = useState(() => document.visibilityState === "visible");
  const [, bump] = useState(0);

  useEffect(() => {
    const on = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  const link = visible ? links.find((l) => states[l.id]?.status === "needsConfirm" && !isHeld(l.id)) : undefined;
  if (!link) return null;
  const cancel = () => {
    holdLink(link.id);
    bump((n) => n + 1);
  };
  return (
    <Dialog open onOpenChange={(open) => !open && cancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>파일 {states[link.id].deleteCount}개를 드라이브에서 지울까요?</DialogTitle>
          <DialogDescription>
            PC의 {link.localRoot} 폴더에서 많은 파일이 사라졌습니다. 계속하면 드라이브의 같은 파일도 지웁니다(휴지통에서 되살릴 수 있습니다).
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={cancel}>
            취소
          </Button>
          <Button variant="destructive" onClick={() => requestRun(link.id, { confirmedDeletes: true })}>
            계속
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
