import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { useAppPrefs } from "@/features/settings/appPrefs";
import { isTauri } from "@/features/shell/platform";
import { logError } from "@/lib/errorLog";
import { useSession, useStorage } from "@/storage/StorageContext";

/** 실패하면 이만큼마다 다시 연다 */
const RETRY_MS = 60_000;

/** 설정에서 NAS로 연 폴더를, 로그인해 있는 동안 계속 열어 둔다(화면 없음). 닫으면 멈춘다 */
export function NasHostRoot() {
  const storage = useStorage();
  const { session } = useSession();
  const baseUrl = session.connection.baseUrl;
  const { nasRoot, nasName } = useAppPrefs();
  // 열 때 기억한 이름을 먼저 쓴다: 서버 PC가 막 켜졌을 땐 같은 PC의 서버가 아직 안 떠 계정을 못 읽는다
  const account = useQuery({ queryKey: ["account"], queryFn: () => storage.getAccount(), staleTime: 30_000, enabled: isTauri() && !nasName }).data?.name;
  const name = nasName ?? account;
  useEffect(() => {
    if (!isTauri() || !nasRoot || !name) return;
    const core = import("@tauri-apps/api/core");
    let failed = false;
    // 같은 값으로 이미 열려 있으면 Rust가 그대로 둔다. 폴더가 아직 없거나(늦게 붙는 USB 하드) 실패했으면 다음 번에 다시 연다.
    // 실패는 설정 화면에도 status.error로 보인다. 로그는 실패가 시작될 때 한 번만
    const start = () =>
      core
        .then(({ invoke }) => invoke("nas_host_start", { root: nasRoot, name, server: baseUrl }))
        .then(
          () => void (failed = false),
          (e: unknown) => {
            if (!failed) logError("nas", e);
            failed = true;
          },
        );
    void start();
    const timer = setInterval(() => void start(), RETRY_MS);
    // 닫음·로그아웃(언마운트)·값 변경 때 멈춘다. 값이 바뀌면 이어서 다시 시작한다
    return () => {
      clearInterval(timer);
      void core.then(({ invoke }) => invoke("nas_host_stop")).catch(() => {});
    };
  }, [nasRoot, name, baseUrl]);
  return null;
}
