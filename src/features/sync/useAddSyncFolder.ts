import { useQueryClient } from "@tanstack/react-query";
import { createElement, useRef, useState, type ReactNode } from "react";
import { enableKeepOn, needsKeepOn } from "@/features/settings/keepAppOn";
import { AddSyncDialog, type AddSyncInfo } from "@/features/sync/AddSyncDialog";
import { checkNewLink, isWholeDrive } from "@/features/sync/checkNewLink";
import { accountKey, addLink, getLinks } from "@/features/sync/links";
import { scanFolder } from "@/features/sync/native";
import { requestRun } from "@/features/sync/syncState";
import type { Location } from "@/features/browse/useCurrentDir";
import { useSession, useStorage } from "@/storage/StorageContext";
import { baseName, joinPath } from "@/storage/path";
import type { Entry, Library } from "@/storage/StorageProvider";

type State = { error: string } | { info: AddSyncInfo; localRoot: string; account: string; libId: string; dir: string };

/** PC 폴더를 골라 현재 위치에 동기화 폴더로 연결한다. dialog는 항상 렌더 */
export function useAddSyncFolder(loc: Location, lib: Library | undefined, entries: Entry[]): { start(): void; dialog: ReactNode } {
  const storage = useStorage();
  const { session, makePersistent } = useSession();
  const qc = useQueryClient();
  const [state, setState] = useState<State | null>(null);
  const [busy, setBusy] = useState(false);
  const picking = useRef(false);
  const [openId, setOpenId] = useState(0); // 열 때마다 확인 창 상태(체크박스)를 새로 시작

  async function start() {
    if (!lib || loc.libId === null || picking.current) return;
    picking.current = true;
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({ title: "동기화할 PC 폴더", directory: true });
      if (!picked) return;
      // 디스크 전체를 훑기 전에 거른다
      const name = baseName(picked.replace(/[\\]/g, "/"));
      if (!name || /^[a-z]:$/i.test(name) || isWholeDrive(picked)) return setState({ error: "드라이브 전체는 동기화할 수 없습니다. 폴더를 골라 주세요" });
      const scan = await scanFolder(picked);
      if (scan === "NOT_FOUND") return setState({ error: "폴더를 읽을 수 없습니다" });
      const acc = await qc.fetchQuery({ queryKey: ["account"], queryFn: () => storage.getAccount() });
      const account = accountKey(session.connection.baseUrl, acc.email);
      const quotaLeft = acc.quota === null ? null : acc.quota - acc.usage;
      const check = checkNewLink({
        links: getLinks(account),
        libId: loc.libId,
        dir: loc.path,
        localRoot: picked,
        name,
        lib,
        existing: entries.find((e) => e.name === name),
        totalBytes: scan.totalBytes,
        quotaLeft,
      });
      if (!check.ok) return setState({ error: check.reason });
      const keep = await needsKeepOn();
      setOpenId((n) => n + 1);
      setState({
        localRoot: picked,
        account,
        libId: loc.libId,
        dir: loc.path,
        info: {
          name,
          totalBytes: scan.totalBytes,
          fileCount: scan.files.length,
          quotaLeft,
          existing: check.existing,
          network: picked.startsWith("\\\\"),
          keepOn: keep.any,
          autoLoginOff: keep.autoLoginOff,
        },
      });
    } catch (e) {
      setState({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      picking.current = false;
    }
  }

  async function confirm(keepOn: boolean) {
    if (!state || "error" in state) return;
    const { info, localRoot, account, libId, dir } = state;
    const drivePath = joinPath(dir, info.name);
    setBusy(true);
    try {
      if (!info.existing) await storage.mkdir(libId, drivePath);
    } catch (e) {
      setBusy(false);
      return setState({ error: e instanceof Error ? e.message : "폴더를 만들지 못했습니다" });
    }
    const id = crypto.randomUUID();
    addLink({ id, account, libId, drivePath, localRoot, paused: false, fresh: info.existing });
    const failed = keepOn ? await enableKeepOn(makePersistent) : null;
    requestRun(id); // SyncRoot가 먼저 실행했으면 아무 일도 안 한다
    void qc.invalidateQueries({ queryKey: ["dir", libId, dir] });
    setBusy(false);
    setState(failed ? { error: failed } : null);
  }

  return {
    start: () => void start(),
    dialog: createElement(AddSyncDialog, { key: openId, state: state && ("error" in state ? state : state.info), busy, onConfirm: confirm, onCancel: () => setState(null) }),
  };
}
