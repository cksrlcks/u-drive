import { useEffect, useState } from "react";
import { isTauri } from "@/features/shell/platform";

export type NasHostStatus = { open: boolean; root: string | null; indexed: number; indexing: boolean; error: string | null };

const CLOSED: NasHostStatus = { open: false, root: null, indexed: 0, indexing: false, error: null };

/** 내 PC를 NAS로 연 상태(Rust nas_host_status + nas-host-status 이벤트) */
export function useNasHostStatus(): NasHostStatus {
  const [status, setStatus] = useState(CLOSED);
  useEffect(() => {
    if (!isTauri()) return;
    let off = () => {};
    let gone = false;
    void (async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      const { listen } = await import("@tauri-apps/api/event");
      const un = await listen<NasHostStatus>("nas-host-status", (e) => setStatus(e.payload));
      if (gone) return un();
      off = un;
      setStatus(await invoke<NasHostStatus>("nas_host_status"));
    })().catch(() => {});
    return () => {
      gone = true;
      off();
    };
  }, []);
  return status;
}
