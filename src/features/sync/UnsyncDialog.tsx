import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export function UnsyncDialog({ open, onConfirm, onCancel }: { open: boolean; onConfirm(): void; onCancel(): void }) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>동기화를 해제할까요?</DialogTitle>
          <DialogDescription>드라이브 폴더와 파일은 그대로 남고 일반 폴더가 됩니다.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            취소
          </Button>
          <Button onClick={onConfirm}>해제</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
