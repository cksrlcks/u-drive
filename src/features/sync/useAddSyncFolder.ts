import { useQueryClient } from "@tanstack/react-query";
import { createElement, useState, type ReactNode } from "react";
import { setPrefs, getPrefs } from "@/features/settings/appPrefs";
import { AddSyncDialog, type AddSyncInfo } from "@/features/sync/AddSyncDialog";
import { checkNewLink } from "@/features/sync/checkNewLink";
import { accountKey, addLink, getLinks } from "@/features/sync/links";
import { scanFolder } from "@/features/sync/native";
import { requestRun } from "@/features/sync/syncState";
import type { Location } from "@/features/browse/useCurrentDir";
import { useSession, useStorage } from "@/storage/StorageContext";
import { baseName, joinPath } from "@/storage/path";
import { isPersistent } from "@/storage/session";
import type { Entry, Library } from "@/storage/StorageProvider";

type State = { error: string } | { info: AddSyncInfo; localRoot: string; account: string };

/** PC 폴더를 골라 현재 위치에 동기화 폴더로 연결한다. dialog는 항상 렌더 */
export function useAddSyncFolder(loc: Location, lib: Library | undefined, entries: Entry[]): { start(): void; dialog: ReactNode } {
  const storage = useStorage();
  const { session, makePersistent } = useSession();
  const qc = useQueryClient();
  const [state, setState] = useState<State | null>(null);
  const [busy, setBusy] = useState(false);

  async function start() {
    if (!lib || loc.libId === null) return;
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({ title: "동기화할 PC 폴더", directory: true });
      if (!picked) return;
      const scan = await scanFolder(picked);
      if (scan === "NOT_FOUND") return setState({ error: "폴더를 읽을 수 없습니다" });
      const acc = await qc.fetchQuery({ queryKey: ["account"], queryFn: () => storage.getAccount() });
      const account = accountKey(session.connection.baseUrl, acc.email);
      const name = baseName(picked.replace(/[\\]/g, "/"));
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
      const autostart = await import("@tauri-apps/plugin-autostart").then((a) => a.isEnabled(), () => true);
      const autoLogin = isPersistent();
      setState({
        localRoot: picked,
        account,
        info: {
          name,
          totalBytes: scan.totalBytes,
          fileCount: scan.files.length,
          quotaLeft,
          existing: check.existing,
          network: picked.startsWith("\\\\"),
          keepOn: !autostart || !getPrefs().closeToTray || !autoLogin,
          autoLoginOff: !autoLogin,
        },
      });
    } catch (e) {
      setState({ error: e instanceof Error ? e.message : String(e) });
    }
  }

  async function confirm(keepOn: boolean) {
    if (!state || "error" in state || loc.libId === null) return;
    const { info, localRoot, account } = state;
    const drivePath = joinPath(loc.path, info.name);
    setBusy(true);
    try {
      if (!info.existing) await storage.mkdir(loc.libId, drivePath);
      const id = crypto.randomUUID();
      addLink({ id, account, libId: loc.libId, drivePath, localRoot, paused: false, fresh: info.existing });
      if (keepOn) {
        try {
          await import("@tauri-apps/plugin-autostart").then((a) => a.enable());
        } catch {
          // 자동 실행을 못 켜도 동기화 자체는 계속한다
        }
        setPrefs({ closeToTray: true });
        makePersistent();
      }
      requestRun(id); // SyncRoot가 먼저 실행했으면 아무 일도 안 한다
      void qc.invalidateQueries({ queryKey: ["dir", loc.libId, loc.path] });
      setState(null);
    } catch (e) {
      setState({ error: e instanceof Error ? e.message : "폴더를 만들지 못했습니다" });
    } finally {
      setBusy(false);
    }
  }

  return {
    start: () => void start(),
    dialog: createElement(AddSyncDialog, { state: state && ("error" in state ? state : state.info), busy, onConfirm: confirm, onCancel: () => setState(null) }),
  };
}
