import type { Entry } from "../StorageProvider";
import { parseNasUrl } from "./withNas";

export type NasPeer = { id: string; name: string };

export type NasClient = {
  peers(): NasPeer[];
  info(peerId: string): Promise<{ name: string; version: number }>;
  list(peerId: string, path: string): Promise<Entry[]>;
  index(peerId: string): Promise<Entry[]>;
};

type RawEntry = { name: string; type: "file" | "dir"; size: number; mtime: number; path: string };

const call = async <T>(cmd: string, args: Record<string, unknown>) => (await import("@tauri-apps/api/core")).invoke<T>(cmd, args);
const toEntries = (rows: RawEntry[]): Entry[] => rows.map((r) => ({ ...r, id: r.path }));

// 동기 peers()를 위해 마지막으로 받은 목록을 들고 있는다
let cache: NasPeer[] = [];
const setPeers = (rows: NasPeer[]) => {
  cache = rows.map(({ id, name }) => ({ id, name }));
};

export const nasClient: NasClient = {
  peers: () => cache,
  info: (peer) => call("nas_info", { peer }),
  list: async (peer, path) => toEntries(await call<RawEntry[]>("nas_list", { peer, path })),
  index: async (peer) => toEntries(await call<RawEntry[]>("nas_index", { peer })),
};

/** 찾은 NAS 목록이 바뀔 때마다 cb. 반환값은 구독 해제 */
export function onNasPeers(cb: () => void): () => void {
  let off: (() => void) | undefined;
  let stopped = false;
  void import("@tauri-apps/api/event").then(({ listen }) =>
    listen<NasPeer[]>("nas-peers", (e) => {
      setPeers(e.payload);
      cb();
    }).then((un) => (stopped ? un() : (off = un))),
  );
  return () => {
    stopped = true;
    off?.();
  };
}

export async function startNasBrowse(server: string): Promise<void> {
  await call("nas_browse", { server });
  setPeers(await call<NasPeer[]>("nas_peers", {}));
}

export async function nasDownload(url: string, dest: string, onProgress: (got: number, total: number) => void): Promise<void> {
  const t = parseNasUrl(url);
  if (!t) throw new Error("NAS 주소가 아닙니다");
  const id = crypto.randomUUID();
  const { listen } = await import("@tauri-apps/api/event");
  const off = await listen<{ id: string; got: number; total: number }>("nas-download", (e) => {
    if (e.payload.id === id) onProgress(e.payload.got, e.payload.total);
  });
  try {
    await call("nas_download", { peer: t.peerId, path: t.path, dest, id });
  } finally {
    off();
  }
}
