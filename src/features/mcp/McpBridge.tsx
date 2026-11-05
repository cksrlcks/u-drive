import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { downloads } from "@/features/download/useDownloads";
import { fetchSearchIndex } from "@/features/search/useSearchIndex";
import { getPrefs } from "@/features/settings/appPrefs";
import { isTauri } from "@/features/shell/platform";
import { useUploadQueue } from "@/features/upload/useUploadQueue";
import { logError } from "@/lib/errorLog";
import { useStorage } from "@/storage/StorageContext";
import { handleLine } from "./protocol";
import type { LocalFile, ToolCtx } from "./tools";

const defaultDownloadDir = async () => getPrefs().downloadDir ?? (await import("@tauri-apps/api/path")).downloadDir();

/** 로그인된 동안의 도구 실행 환경. 로그아웃이면 null → tools/call은 로그인 안내로 답한다 */
let currentCtx: ToolCtx | null = null;

/** Claude(MCP) 요청을 받는 곳. 로그인 여부와 무관하게 앱 최상단에 하나 둔다 */
export function McpBridge(): null {
  useEffect(() => {
    if (!isTauri()) return;
    let off: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      const [{ listen }, { invoke }, { getVersion }] = await Promise.all([import("@tauri-apps/api/event"), import("@tauri-apps/api/core"), import("@tauri-apps/api/app")]);
      const version = await getVersion();
      const unlisten = await listen<{ conn: number; line: string }>("mcp-request", async ({ payload }) => {
        try {
          const reply = await handleLine(payload.line, currentCtx, version);
          if (reply !== null) await invoke("mcp_respond", { conn: payload.conn, line: reply });
        } catch (e) {
          logError("mcp", e); // 연결이 먼저 끊긴 경우 등
        }
      });
      if (cancelled) return unlisten();
      off = unlisten;
      await invoke("mcp_ready"); // 듣기 시작한 뒤에야 Rust가 쌓아 둔 요청을 넘긴다
    })();
    return () => {
      cancelled = true;
      off?.();
    };
  }, []);
  return null;
}

/** 로그인된 화면 안에 둔다. 저장소·업로드 큐·검색 색인으로 도구 실행 환경을 만든다 */
export function McpToolProvider(): null {
  const storage = useStorage();
  const { queue } = useUploadQueue();
  const qc = useQueryClient();

  useEffect(() => {
    if (!isTauri()) return;
    const invoke = async <T,>(cmd: string, args: Record<string, unknown>) => (await import("@tauri-apps/api/core")).invoke<T>(cmd, args);
    currentCtx = {
      storage,
      uploads: queue,
      downloads,
      searchIndex: () => fetchSearchIndex(qc, storage),
      readLocalFile: async (path) => new File([await invoke<ArrayBuffer>("read_local_file", { path })], path.split(/[\\/]/).pop()!),
      freePath: (dir, name) => invoke<string>("free_path", { dir, name }),
      defaultDownloadDir,
      workDir: async () => (await import("@tauri-apps/api/path")).join(await defaultDownloadDir(), "U-Drive 작업"),
      recentFiles: (dir, limit) => invoke<LocalFile[]>("recent_files", { dir, limit }),
      writeLocalFile: (path, data) => invoke<void>("write_local_file", { path, data: Array.from(data) }),
      realPath: (path) => invoke<string>("real_path", { path }),
    };
    return () => {
      currentCtx = null;
    };
  }, [storage, queue, qc]);
  return null;
}
