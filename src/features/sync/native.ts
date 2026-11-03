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
  return json ? (JSON.parse(json) as Baseline) : null;
}

export const writeBaseline = (id: string, b: Baseline) => call<void>("sync_state_write", { id, json: JSON.stringify(b) });
export const deleteBaseline = (id: string) => call<void>("sync_state_delete", { id });
export const watchFolder = (id: string, root: string) => call<void>("sync_watch", { id, root });
export const unwatchFolder = (id: string) => call<void>("sync_unwatch", { id });

export async function onFolderChanged(fn: (id: string) => void): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<string>("sync-changed", (e) => fn(e.payload));
}
