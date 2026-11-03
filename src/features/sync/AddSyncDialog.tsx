import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatSize } from "@/lib/format";

export type AddSyncInfo = {
  name: string;
  totalBytes: number;
  fileCount: number;
  quotaLeft: number | null;
  existing: boolean;
  network: boolean;
  /** 자동 실행·트레이·자동 로그인 중 꺼진 것이 있다 */
  keepOn: boolean;
  autoLoginOff: boolean;
};

type Props = {
  state: { error: string } | AddSyncInfo | null;
  busy: boolean;
  onConfirm(keepOn: boolean): void;
  onCancel(): void;
};

export function AddSyncDialog({ state, busy, onConfirm, onCancel }: Props) {
  const [keepOn, setKeepOn] = useState(true);
  const info = state && !("error" in state) ? state : null;
  return (
    <Dialog open={!!state} onOpenChange={(open) => !open && !busy && onCancel()}>
      <DialogContent>
        {state && "error" in state && (
          <>
            <DialogHeader>
              <DialogTitle>동기화 폴더를 추가할 수 없습니다</DialogTitle>
              <DialogDescription>{state.error}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button onClick={onCancel}>확인</Button>
            </DialogFooter>
          </>
        )}
        {info && (
          <>
            <DialogHeader>
              <DialogTitle>{`'${info.name}' 폴더를 동기화할까요?`}</DialogTitle>
              <DialogDescription>
                {`${formatSize(info.totalBytes)}, 파일 ${info.fileCount}개를 드라이브에 올립니다. 남은 용량 ${info.quotaLeft === null ? "제한 없음" : formatSize(info.quotaLeft)}.`}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2 text-sm text-muted-foreground">
              {info.existing && <p>같은 이름의 폴더가 이미 있습니다. 기존 폴더에 이어서 연결하면 PC 파일을 올리기만 하고, 드라이브의 파일은 지우지 않습니다.</p>}
              {info.network && <p>네트워크 폴더는 변경 알림이 오지 않을 수 있어 반영이 최대 1시간 늦을 수 있습니다.</p>}
              <p>
                앱이 켜져 있을 때만 동기화됩니다.
                {info.autoLoginOff && " 자동 로그인이 꺼져 있어 PC를 다시 켜면 동기화가 멈춥니다."}
              </p>
              {info.keepOn && (
                <label className="flex items-center gap-2 text-foreground">
                  <Checkbox checked={keepOn} onCheckedChange={(v) => setKeepOn(!!v)} />앱을 켜 두는 설정도 함께 켜기
                </label>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={onCancel} disabled={busy}>
                취소
              </Button>
              <Button onClick={() => onConfirm(info.keepOn && keepOn)} disabled={busy}>
                {info.existing ? "이어서 연결" : "동기화 시작"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
