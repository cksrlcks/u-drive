import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { needsKeepOn } from "./keepAppOn";

type Props = {
  /** 고른 폴더 경로. null이면 닫힘 */
  root: string | null;
  onConfirm(keepOn: boolean): void;
  onCancel(): void;
};

/** NAS로 열기 전 확인. 앱을 켜 두는 설정이 꺼져 있으면 함께 켤지 묻는다 */
export function NasOpenDialog({ root, onConfirm, onCancel }: Props) {
  const [keep, setKeep] = useState<{ any: boolean; autoLoginOff: boolean } | null>(null);
  const [keepOn, setKeepOn] = useState(true);
  useEffect(() => {
    if (!root) return;
    setKeepOn(true);
    void needsKeepOn().then(setKeep);
  }, [root]);
  const folder = root?.split(/[\\/]/).filter(Boolean).pop() ?? root;
  return (
    <Dialog open={!!root} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{`'${folder}'를 열까요?`}</DialogTitle>
          <DialogDescription>내려받기만 할 수 있고, 파일은 바뀌지 않습니다.</DialogDescription>
        </DialogHeader>
        <div className="space-y-2 text-sm text-muted-foreground">
          <p>처음 열 때 Windows 방화벽 창이 뜨면 "개인 네트워크"를 허용해 주세요.</p>
          {keep?.any && (
            <>
              {keep.autoLoginOff && <p>자동 로그인이 꺼져 있어 PC를 다시 켜면 멈춥니다.</p>}
              <label className="flex items-center gap-2 text-foreground">
                <Checkbox checked={keepOn} onCheckedChange={(v) => setKeepOn(!!v)} />앱을 켜 두는 설정도 함께 켜기
              </label>
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            취소
          </Button>
          <Button onClick={() => onConfirm(!!keep?.any && keepOn)}>열기</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
