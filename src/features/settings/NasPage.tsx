import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useNasHostStatus } from "@/features/nas/useNasHostStatus";
import { pickFolder } from "@/features/upload/localUpload";
import { useSession, useStorage } from "@/storage/StorageContext";
import { setPrefs, useAppPrefs } from "./appPrefs";
import { enableKeepOn } from "./keepAppOn";
import { NasOpenDialog } from "./NasOpenDialog";

const btn = "h-8 rounded-[10px] border border-border bg-card px-3 text-sm outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-primary/40";

/** 이 PC의 하드 폴더를 같은 네트워크의 Drive 앱에 읽기 전용으로 보여 준다 */
export function NasPage() {
  const storage = useStorage();
  const { makePersistent } = useSession();
  const { nasRoot } = useAppPrefs();
  const status = useNasHostStatus();
  const account = useQuery({ queryKey: ["account"], queryFn: () => storage.getAccount(), staleTime: 30_000 }).data?.name;
  const name = account ?? "…";
  const [picked, setPicked] = useState<string | null>(null);
  const [warn, setWarn] = useState<string | null>(null);

  async function pick() {
    const dir = await pickFolder("NAS로 열 폴더");
    if (dir) setPicked(dir);
  }
  async function open(keepOn: boolean) {
    const root = picked;
    setPicked(null);
    if (!root) return;
    setWarn(keepOn ? await enableKeepOn(makePersistent) : null);
    setPrefs({ nasRoot: root, nasName: account ?? null });
  }

  return (
    <>
      <p className="mb-6 text-sm text-muted-foreground">이 PC에 연결된 하드 폴더를 열어 두면, 같은 사무실 네트워크의 Drive 앱에 '{name}'으로 보입니다.</p>
      <div className="flex flex-col items-start gap-3">
        {nasRoot ? (
          <>
            <span className="text-base font-semibold break-all">{nasRoot}</span>
            <span className="text-sm text-muted-foreground">
              검색 색인 {status.indexed}개{status.indexing ? " 만드는 중…" : ""}
            </span>
            {status.error && <span className="text-sm text-destructive">{status.error}</span>}
            {warn && <span className="text-sm text-destructive">{warn}</span>}
            <button type="button" onClick={() => setPrefs({ nasRoot: null, nasName: null })} className={btn}>
              닫기
            </button>
          </>
        ) : (
          <>
            {warn && <span className="text-sm text-destructive">{warn}</span>}
            <button type="button" onClick={() => void pick()} className={btn}>
              폴더 골라서 열기
            </button>
          </>
        )}
      </div>
      <NasOpenDialog root={picked} onConfirm={(k) => void open(k)} onCancel={() => setPicked(null)} />
    </>
  );
}
