import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export type SyncWarning = { localRoot: string; removeRoot: boolean };

export function SyncWarningDialog({ warning, onChoice }: { warning: SyncWarning | null; onChoice(ok: boolean): void }) {
  return (
    <Dialog open={!!warning} onOpenChange={(open) => !open && onChoice(false)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>동기화 중인 폴더입니다</DialogTitle>
          <DialogDescription>
            {warning?.removeRoot
              ? "동기화 연결이 끊깁니다. 연결만 해제하려면 우클릭 → 동기화 해제를 쓰세요."
              : `이 폴더는 PC의 ${warning?.localRoot} 폴더와 동기화 중입니다. 여기서 바꾼 내용은 PC에 반영되지 않고, PC에서 같은 파일을 저장하면 덮어써집니다.`}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onChoice(false)}>
            취소
          </Button>
          <Button variant={warning?.removeRoot ? "destructive" : "default"} onClick={() => onChoice(true)}>
            {warning?.removeRoot ? "삭제" : "계속"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
