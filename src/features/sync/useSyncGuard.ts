import { useQuery } from "@tanstack/react-query";
import { createElement, useRef, useState, type ReactNode } from "react";
import { useSession, useStorage } from "@/storage/StorageContext";
import { accountKey, findLink, linkUnder, movesLinkIntoLink, useLinks } from "./links";
import { SyncWarningDialog, type SyncWarning } from "./SyncWarningDialog";

/** change: 이름 변경·이동(연결 폴더 자체는 따라가므로 경고 없음) / inside: 폴더 안을 바꿈(자체 포함) / removeRoot: 삭제(대상에 연결 폴더 자체가 있으면 연결 끊김 문구, 아니면 일반 문구) */
export type GuardKind = "change" | "inside" | "removeRoot";

/** 경고가 필요 없으면 바로 true. 필요하면 확인 창을 띄우고 [계속]이면 true */
export function useSyncGuard(libId: string | null): { guard(paths: string[], kind?: GuardKind): Promise<boolean>; guardMove(paths: string[], dstDir: string): Promise<boolean>; dialog: ReactNode } {
  const storage = useStorage();
  const { session } = useSession();
  const acc = useQuery({ queryKey: ["account"], queryFn: () => storage.getAccount() });
  const links = useLinks(acc.data?.email ? accountKey(session.connection.baseUrl, acc.data.email) : "");
  const [warning, setWarning] = useState<SyncWarning | null>(null);
  const resolveRef = useRef<((ok: boolean) => void) | null>(null);

  const ask = (w: SyncWarning) =>
    new Promise<boolean>((resolve) => {
      resolveRef.current?.(false); // 열린 창이 있으면 이전 요청은 취소로 끝낸다
      resolveRef.current = resolve;
      setWarning(w);
    });

  const guard = async (paths: string[], kind: GuardKind = "change") => {
    if (!libId) return true;
    // 삭제는 연결 폴더의 조상을 지워도 연결이 끊기므로 같이 잡는다
    const hit =
      kind === "removeRoot"
        ? paths.map((p) => linkUnder(links, libId, p) ?? findLink(links, libId, p)).find(Boolean)
        : paths.map((p) => findLink(links, libId, p)).find((l, i) => l && (kind !== "change" || paths[i] !== l.drivePath));
    if (!hit) return true;
    return ask({ localRoot: hit.localRoot, removeRoot: kind === "removeRoot" && paths.some((p) => !!linkUnder(links, libId, p)) });
  };
  /** 연결 폴더를 다른 연결 폴더 안으로 옮기는 건 막는다(안내 후 false) */
  const guardMove = async (paths: string[], dstDir: string) => {
    if (!libId || !movesLinkIntoLink(links, libId, paths, dstDir)) return true;
    await ask({ localRoot: "", removeRoot: false, refuse: true });
    return false;
  };
  const onChoice = (ok: boolean) => {
    resolveRef.current?.(ok);
    resolveRef.current = null;
    setWarning(null);
  };
  return { guard, guardMove, dialog: createElement(SyncWarningDialog, { warning, onChoice }) };
}
