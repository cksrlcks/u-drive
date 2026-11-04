import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { isTauri } from "@/features/shell/platform";
import { logError } from "@/lib/errorLog";
import { onNasPeers, startNasBrowse } from "@/storage/nas/native";
import { useSession } from "@/storage/StorageContext";

const REFRESH_MS = 5 * 60_000;

/** 데스크톱 앱에서 로그인해 있는 동안 디자인나스를 찾는다(화면 없음). 목록은 찾을 때마다·5분마다 새로 읽어 색인 버전을 따라간다 */
export function NasRoot() {
  const qc = useQueryClient();
  const { session } = useSession();
  const baseUrl = session.connection.baseUrl;
  useEffect(() => {
    if (!isTauri()) return;
    const refresh = () => void qc.invalidateQueries({ queryKey: ["libraries"] });
    const off = onNasPeers(refresh);
    const timer = setInterval(refresh, REFRESH_MS);
    void startNasBrowse(baseUrl).catch((e: unknown) => logError("nas", e)); // 못 찾아도 앱은 그대로 — 다음 이벤트·갱신을 기다린다
    return () => {
      off();
      clearInterval(timer);
    };
  }, [qc, baseUrl]);
  return null;
}
