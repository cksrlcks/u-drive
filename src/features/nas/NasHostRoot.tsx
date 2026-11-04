import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { useAppPrefs } from "@/features/settings/appPrefs";
import { isTauri } from "@/features/shell/platform";
import { logError } from "@/lib/errorLog";
import { useSession, useStorage } from "@/storage/StorageContext";

/** 설정에서 NAS로 연 폴더를, 로그인해 있는 동안 계속 열어 둔다(화면 없음). 닫으면 멈춘다 */
export function NasHostRoot() {
  const storage = useStorage();
  const { session } = useSession();
  const baseUrl = session.connection.baseUrl;
  const { nasRoot } = useAppPrefs();
  const name = useQuery({ queryKey: ["account"], queryFn: () => storage.getAccount(), staleTime: 30_000, enabled: isTauri() }).data?.name;
  useEffect(() => {
    if (!isTauri()) return;
    void import("@tauri-apps/api/core").then(({ invoke }) => {
      if (!nasRoot) return invoke("nas_host_stop");
      // 실패는 설정 화면에도 status.error로 보인다
      if (name) return invoke("nas_host_start", { root: nasRoot, name, server: baseUrl }).catch((e: unknown) => logError("nas", e));
    });
  }, [nasRoot, name, baseUrl]);
  return null;
}
