import { logError } from "@/lib/errorLog";
import type { Baseline, Scan } from "./type";

const call = async <T>(cmd: string, args: Record<string, unknown>) => (await import("@tauri-apps/api/core")).invoke<T>(cmd, args);

/** 폴더가 없으면 "NOT_FOUND". 다른 실패는 그대로 throw */
export async function scanFolder(root: string): Promise<Scan | "NOT_FOUND"> {
  try {
    return await call<Scan>("sync_scan", { root });
  } catch (e) {
    if (e === "NOT_FOUND") return "NOT_FOUND";
    throw e;
  }
}

export async function readBaseline(id: string): Promise<Baseline | null> {
  const json = await call<string | null>("sync_state_read", { id });
  if (!json) return null;
  // 깨진 상태는 빈 기준 상태로 되돌린다: 빈 기준 상태는 아무것도 지우지 않아 안전하다
  try {
    const b = JSON.parse(json) as Baseline;
    if (b && typeof b.files === "object" && b.files !== null && !Array.isArray(b.files) && Array.isArray(b.dirs)) return b;
    throw new Error("기준 상태 형식이 맞지 않습니다");
  } catch (e) {
    logError("sync", e);
    return null;
  }
}

export const writeBaseline = (id: string, b: Baseline) => call<void>("sync_state_write", { id, json: JSON.stringify(b) });
export const deleteBaseline = (id: string) => call<void>("sync_state_delete", { id });
export const watchFolder = (id: string, root: string) => call<void>("sync_watch", { id, root });
export const unwatchFolder = (id: string) => call<void>("sync_unwatch", { id });

export async function onFolderChanged(fn: (id: string) => void): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<string>("sync-changed", (e) => fn(e.payload));
}
