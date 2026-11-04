import { cn } from "cn";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { PreviewModal } from "@/features/preview/PreviewModal";
import { previewKind } from "@/features/preview/previewKind";
import { ShareDialog } from "@/features/share/ShareDialog";
import { ShareLinksPage } from "@/features/share/ShareLinksPage";
import { SettingsDialog, type SettingsPage } from "@/features/settings/SettingsDialog";
import { TrashPage } from "@/features/trash/TrashPage";
import { checkForUpdate } from "@/features/shell/updater";
import { UpdateNotice } from "@/features/shell/UpdateNotice";
import { StatusBar } from "@/features/shell/StatusBar";
import { isTauri } from "@/features/shell/platform";
import { TitleBar, type Crumb } from "@/features/shell/TitleBar";
import { DropZone, type DropZoneHandle } from "@/features/upload/DropZone";
import { OverwriteDialog, type OverwriteChoice } from "@/features/upload/OverwriteDialog";
import { planUploads } from "@/features/upload/planUploads";
import { UploadPanel } from "@/features/upload/UploadPanel";
import { DownloadPanel } from "@/features/download/DownloadPanel";
import { NearbyPanel } from "@/features/nearby/NearbyPanel";
import { SendDialog, type SendSource } from "@/features/nearby/SendDialog";
import { useUploadQueueInstance } from "@/features/upload/useUploadQueue";
import { useSession, useStorage } from "@/storage/StorageContext";
import { useStoredState } from "@/lib/useStoredState";
import { useMarquee } from "./useMarquee";
import { useSidebarWidth } from "./useSidebarWidth";
import { prefetchShellIcons } from "./useShellIcon";
import { baseName, joinPath, parentPath, splitPath } from "@/storage/path";
import type { Entry, Library, UploadTask } from "@/storage/StorageProvider";
import type { EntryMenuActions } from "./ContextMenu";
import { DeleteDialog } from "./DeleteDialog";
import { BackgroundContextMenu } from "./BackgroundContextMenu";
import { FileList, FileListSkeleton, orderEntries, type Sort, type SortKey, type ViewMode } from "./FileList";
import { DetailsPanel } from "./DetailsPanel";
import { ICON_SIZES, IconGrid } from "./IconGrid";
import { Sidebar } from "./Sidebar";
import { useCurrentDir, useLibraries, type Location } from "./useCurrentDir";
import { useSyncGuard } from "@/features/sync/useSyncGuard";
import { useAddSyncFolder } from "@/features/sync/useAddSyncFolder";
import { isSyncProblem } from "@/features/sync/constants";
import { accountKey, findLink, removeLink, useLinks } from "@/features/sync/links";
import { deleteBaseline, unwatchFolder } from "@/features/sync/native";
import { releaseHold, useAllLinkStates } from "@/features/sync/syncState";
import type { SyncLink } from "@/features/sync/type";
import { UnsyncDialog } from "@/features/sync/UnsyncDialog";
import { useEntryActions, type MoveOp } from "./useEntryActions";
import { useDragMove } from "./useDragMove";
import { MoveNotice } from "./MoveNotice";

export function MainScreen() {
  const { logout, session } = useSession();
  const storage = useStorage();
  const qc = useQueryClient();
  const libs = useLibraries();

  // ---- 위치 + 뒤로/앞으로 히스토리 ----
  const [history, setHistory] = useState<{ stack: Location[]; index: number }>({ stack: [{ libId: null, path: "/" }], index: 0 });
  const loc = history.stack[history.index];
  const setLoc = useCallback((next: Location) => {
    setHistory((h) => {
      const cur = h.stack[h.index];
      if (cur.libId === next.libId && cur.path === next.path) return h;
      const stack = [...h.stack.slice(0, h.index + 1), next];
      return { stack, index: stack.length - 1 };
    });
    setPage("files");
    setSelected(new Set());
    setFocusPath(null);
    setRenamingPath(null);
    setCreatingFolder(false);
  }, []);
  const canBack = history.index > 0;
  const canForward = history.index < history.stack.length - 1;
  const go = (delta: number) => {
    setHistory((h) => ({ ...h, index: Math.max(0, Math.min(h.stack.length - 1, h.index + delta)) }));
    setPage("files");
    setSelected(new Set());
  };

  // 마우스 뒤로·앞으로 버튼(탐색기처럼). go는 setState만 써서 한 번만 등록해도 된다
  useEffect(() => {
    const onUp = (e: MouseEvent) => {
      if (e.button === 3 || e.button === 4) (e.preventDefault(), go(e.button === 3 ? -1 : 1));
    };
    window.addEventListener("mouseup", onUp);
    return () => window.removeEventListener("mouseup", onUp);
  }, []);

  useEffect(() => {
    if (loc.libId !== null || !libs.data) return;
    const first = libs.data.find((l) => !l.encrypted);
    if (first) setHistory({ stack: [{ libId: first.id, path: "/" }], index: 0 });
  }, [libs.data, loc.libId]);

  const dir = useCurrentDir(loc);
  const lib = libs.data?.find((l) => l.id === loc.libId);
  // 동기화 폴더 표시: 지금 계정·저장소의 연결만
  const accQ = useQuery({ queryKey: ["account"], queryFn: () => storage.getAccount(), staleTime: 30_000, enabled: isTauri() });
  const syncAccount = accQ.data?.email ? accountKey(session.connection.baseUrl, accQ.data.email) : "";
  const allLinks = useLinks(syncAccount);
  // 동기화 폴더 안은 PC가 기준이라 읽기만 한다(읽기 전용 저장소와 같은 규칙)
  const syncReadOnly = !!loc.libId && !!findLink(allLinks, loc.libId, loc.path);
  const readOnly = !!lib?.readOnly || syncReadOnly;
  const crumbs: Crumb[] = useMemo(() => {
    if (!lib) return [];
    const segs = splitPath(loc.path);
    return [{ label: lib.name, path: "/" }, ...segs.map((s, i) => ({ label: s, path: "/" + segs.slice(0, i + 1).join("/") }))];
  }, [lib, loc.path]);

  // ---- 보기·정렬·필터 ----
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const sidebar = useSidebarWidth();
  const [view, setView] = useState<ViewMode>("list");
  const [detailsOpen, setDetailsOpen] = useStoredState("seadrive.details", true);
  const [iconSize, setIconSize] = useStoredState("seadrive.iconSize", 1);
  const [sort, setSort] = useState<Sort>({ key: "name", dir: "asc" });
  const entries = useMemo(() => orderEntries(dir.data ?? [], sort), [dir.data, sort]);
  const onSort = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }));

  // ---- 선택 (클릭 / Ctrl / Shift / 키보드) ----
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [focusPath, setFocusPath] = useState<string | null>(null);
  const anchor = useRef<string | null>(null);
  const select = (entry: Entry, e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => {
    const multi = e.ctrlKey || e.metaKey;
    setSelected((s) => {
      if (e.shiftKey && anchor.current) {
        const a = entries.findIndex((x) => x.path === anchor.current);
        const b = entries.findIndex((x) => x.path === entry.path);
        const [lo, hi] = a < b ? [a, b] : [b, a];
        const range = entries.slice(lo, hi + 1).map((x) => x.path);
        return new Set(multi ? [...s, ...range] : range);
      }
      if (multi) {
        const n = new Set(s);
        if (n.has(entry.path)) n.delete(entry.path);
        else n.add(entry.path);
        return n;
      }
      return new Set([entry.path]);
    });
    if (!e.shiftKey) anchor.current = entry.path;
    setFocusPath(entry.path);
  };
  const selectedEntries = entries.filter((e) => selected.has(e.path));

  // ---- 업로드 ----
  const dropRef = useRef<DropZoneHandle>(null);
  const queue = useUploadQueueInstance(); // 진행 알림마다 화면 전체를 다시 그리지 않게 구독하지 않는다
  const [pending, setPending] = useState<{ conflicts: UploadTask[]; fresh: UploadTask[] } | null>(null);
  const { guard, guardMove, dialog: guardDialog } = useSyncGuard(loc.libId);
  async function onFiles(tasks: UploadTask[]) {
    if (!loc.libId || !(await guard([loc.path], "inside"))) return;
    const plan = planUploads(tasks, dir.data ?? []);
    if (plan.conflicts.length === 0) queue.add(loc.libId, plan.fresh);
    else setPending(plan);
  }
  function onOverwriteChoice(c: OverwriteChoice) {
    if (pending && loc.libId) {
      if (c === "overwrite") queue.add(loc.libId, [...pending.fresh, ...pending.conflicts]);
      else if (c === "skip") queue.add(loc.libId, pending.fresh);
    }
    setPending(null);
  }

  // ---- 파일 조작 ----
  const ops = useEntryActions(loc);
  const sync = useAddSyncFolder(loc, lib, entries);
  const renameLibrary = useMutation({
    mutationFn: ({ lib, newName }: { lib: Library; newName: string }) => storage.renameLibrary(lib.id, newName),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["libraries"] }),
  });
  const starLibrary = useMutation({
    mutationFn: ({ lib, starred }: { lib: Library; starred: boolean }) => storage.starLibrary(lib.id, starred),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["libraries"] }),
  });
  // ---- 끌어서 옮기기: 같은 저장소 안, 지금 폴더의 하위 폴더로만. 놓은 뒤 잠시 실행 취소를 띄운다 ----
  const [lastMove, setLastMove] = useState<MoveOp | null>(null);
  const closeMoveNotice = useCallback(() => setLastMove(null), []);
  const undoMove = async () => {
    if (!lastMove) return;
    const op = { ...lastMove, srcDir: lastMove.dstDir, dstDir: lastMove.srcDir };
    setLastMove(null); // 확인 창이 떠 있는 동안 또 눌려도 두 번 실행되지 않게 먼저 비운다
    if (!(await guardMove(op.names.map((n) => joinPath(op.srcDir, n)), op.dstDir)) || !(await guard([op.srcDir, op.dstDir], "inside"))) return;
    ops.move.mutate(op);
  };
  const dirName = (path: string) => (path === "/" ? (lib?.name ?? "/") : baseName(path));
  const dragMove = useDragMove(
    entries,
    selected,
    setSelected,
    async (items, dstDir) => {
      if (!(await guardMove(items.map((x) => x.path), dstDir)) || !(await guard([loc.path, dstDir], "inside"))) return;
      const op = { libId: loc.libId!, srcDir: loc.path, names: items.map((x) => x.name), dstDir };
      ops.move.mutate(op, { onSuccess: () => setLastMove(op) });
      setSelected(new Set());
    },
    readOnly,
  );
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [deleting, setDeleting] = useState<Entry[]>([]);
  // 동기화 폴더 경고를 먼저 거친 뒤 삭제 확인 창을 연다
  const askDelete = async (list: Entry[]) => {
    if (await guard(list.map((e) => e.path), "removeRoot")) setDeleting(list);
  };
  const [sharing, setSharing] = useState<Entry | null>(null);
  const [nearbySend, setNearbySend] = useState<SendSource | null>(null);
  // 선택한 파일들(우클릭한 파일이 선택에 없으면 그 파일만). 폴더는 보내지 않는다
  const sendNearby = (e?: Entry) => {
    const list = (e && !selected.has(e.path) ? [e] : selectedEntries).filter((x) => x.type === "file");
    if (loc.libId && list.length) setNearbySend({ kind: "drive", libId: loc.libId, entries: list });
    else setNearbySend({ kind: "local" });
  };
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsPage, setSettingsPage] = useState<SettingsPage>("general");
  const openSettings = (page: SettingsPage = "general") => {
    setSettingsPage(page);
    setSettingsOpen(true);
  };
  /** 메인 영역: 파일 탐색 · 공유 링크 · 휴지통 페이지. 어디로든 이동하면 파일 탐색으로 돌아온다 */
  const [page, setPage] = useState<"files" | "links" | "trash">("files");
  const openTrash = () => {
    setPage("trash");
    setSelected(new Set());
  };
  useEffect(() => void checkForUpdate(), []); // 시작할 때 한 번 조용히 확인
  useEffect(() => prefetchShellIcons(qc), [qc]);
  const openLinks = () => {
    setPage("links");
    setSelected(new Set());
  };
  // 파일 목록의 공유 표시와 상태바 "링크 N개"용. 공유 링크 페이지와 같은 쿼리 키라 캐시를 같이 쓴다
  const shareLinks = useQuery({ queryKey: ["share-links"], queryFn: () => storage.listShareLinks() });
  const sharedPaths = useMemo(() => new Set((shareLinks.data ?? []).filter((l) => l.libId === loc.libId).map((l) => l.path)), [shareLinks.data, loc.libId]);
  const linkStates = useAllLinkStates();
  const syncLinks = useMemo(() => new Map(allLinks.filter((l) => l.libId === loc.libId).map((l) => [l.drivePath, l])), [allLinks, loc.libId]);
  const [unsyncing, setUnsyncing] = useState<SyncLink | null>(null);
  const syncing = allLinks.filter((l) => linkStates[l.id]?.status === "syncing");
  const problem = allLinks.filter((l) => isSyncProblem(linkStates[l.id]?.status ?? "idle"));
  const syncNote = [syncing.length > 0 && `동기화 중 ${syncing.reduce((a, l) => a + linkStates[l.id].pending, 0)}개`, problem.length > 0 && `동기화 오류 ${problem.length}건`].filter(Boolean).join(" · ");
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const previewable = lib?.nas ? [] : entries.filter((e) => e.type === "file" && previewKind(e.name) !== null);
  const previewIndex = previewable.findIndex((e) => e.path === previewPath);

  function open(entry: Entry) {
    if (entry.type === "dir") setLoc({ ...loc, path: entry.path });
    else if (!lib?.nas && previewKind(entry.name)) setPreviewPath(entry.path);
    else ops.download.mutate([entry]);
  }
  const menuActions: EntryMenuActions = {
    onOpen: open,
    onDownload: (e) => ops.download.mutate(selected.has(e.path) && selectedEntries.length > 1 ? selectedEntries : [e]),
    onRename: readOnly ? undefined : (e) => setRenamingPath(e.path),
    onShare: lib?.nas ? undefined : (e) => setSharing(e),
    onNearby: isTauri() && !lib?.nas ? sendNearby : undefined,
    onDelete: readOnly ? undefined : (e) => void askDelete(selected.has(e.path) && selectedEntries.length > 1 ? selectedEntries : [e]),
    syncMenu: isTauri() ? (e) => (syncLinks.get(e.path) ? { link: syncLinks.get(e.path)! } : undefined) : undefined,
    onUnsync: setUnsyncing,
  };

  // ---- 키보드 ----
  const listRef = useRef<HTMLDivElement>(null);
  // 미리보기를 닫으면 키보드 포커스를 파일 목록으로 돌려준다
  const closePreview = () => {
    setPreviewPath(null);
    listRef.current?.focus();
  };
  const marquee = useMarquee(listRef, selected, setSelected);
  function onKeyDown(e: React.KeyboardEvent) {
    if (renamingPath || creatingFolder || (e.target as HTMLElement).tagName === "INPUT") return;
    const idx = entries.findIndex((x) => x.path === focusPath);
    const moveTo = (i: number) => {
      const t = entries[Math.max(0, Math.min(entries.length - 1, i))];
      if (!t) return;
      if (e.shiftKey) select(t, { ctrlKey: false, metaKey: false, shiftKey: true });
      else select(t, { ctrlKey: false, metaKey: false, shiftKey: false });
      listRef.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(t.path)}"]`)?.scrollIntoView({ block: "nearest" });
    };
    const mod = e.ctrlKey || e.metaKey;
    // 아이콘 보기: ↑↓는 한 줄(열 개수만큼), ←→는 한 칸 — 탐색기와 같다
    const grid = view === "grid" ? listRef.current?.firstElementChild : null;
    const cols = grid ? getComputedStyle(grid).gridTemplateColumns.split(" ").length : 1;
    const step = (d: number) => (e.preventDefault(), moveTo(idx < 0 ? 0 : idx + d));
    if (e.key === "ArrowDown") step(cols);
    else if (e.key === "ArrowUp") step(-cols);
    else if (grid && !e.altKey && e.key === "ArrowRight") step(1);
    else if (grid && !e.altKey && e.key === "ArrowLeft") step(-1);
    else if (e.key === "Home") (e.preventDefault(), moveTo(0));
    else if (e.key === "End") (e.preventDefault(), moveTo(entries.length - 1));
    else if (e.key === "Enter" && focusPath) (e.preventDefault(), open(entries[idx]));
    else if (e.key === "Backspace" && loc.path !== "/") (e.preventDefault(), setLoc({ ...loc, path: parentPath(loc.path) }));
    else if (e.key === "F2" && focusPath && !readOnly) (e.preventDefault(), setRenamingPath(focusPath));
    else if (e.key === "Delete" && selectedEntries.length && !readOnly) (e.preventDefault(), void askDelete(selectedEntries));
    else if (e.key === "Escape") setSelected(new Set());
    else if (mod && e.key.toLowerCase() === "a") (e.preventDefault(), setSelected(new Set(entries.map((x) => x.path))));
    else if (e.altKey && e.key === "ArrowLeft") (e.preventDefault(), go(-1));
    else if (e.altKey && e.key === "ArrowRight") (e.preventDefault(), go(1));
    else if (e.key === "F5") (e.preventDefault(), void qc.invalidateQueries({ queryKey: ["dir"] }));
    else if (mod && e.shiftKey && e.key.toLowerCase() === "n" && !readOnly) (e.preventDefault(), setCreatingFolder(true));
    else if (mod && e.key === ",") (e.preventDefault(), openSettings());
    else if (mod && e.key.toLowerCase() === "z" && lastMove) (e.preventDefault(), void undoMove());
  }

  // 아이콘 보기 Ctrl+휠: 크기 단계 조절(탐색기처럼). preventDefault가 필요해 passive가 아닌 리스너로 직접 단다
  const wheelAcc = useRef(0);
  useEffect(() => {
    const el = listRef.current;
    if (!el || view !== "grid") return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      // 터치패드는 작은 delta가 여러 번 온다. 마우스 한 칸(약 100)만큼 모이면 한 단계
      wheelAcc.current += e.deltaY;
      if (Math.abs(wheelAcc.current) < 100) return;
      const d = wheelAcc.current < 0 ? 1 : -1;
      wheelAcc.current = 0;
      setIconSize((s) => Math.max(0, Math.min(ICON_SIZES.length - 1, s + d)));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [view, page, setIconSize]);

  const listProps = {
    entries,
    sharedPaths,
    syncLinks,
    sort,
    onSort,
    selected,
    focusPath,
    onSelect: select,
    onOpen: open,
    actions: menuActions,
    existingNames: (dir.data ?? []).map((e) => e.name),
    renamingPath,
    onRenameSubmit: async (entry: Entry, newName: string) => {
      setRenamingPath(null);
      if (!(await guard([entry.path]))) return;
      ops.rename.mutate({ entry, newName });
    },
    onRenameCancel: () => setRenamingPath(null),
    creatingFolder,
    onCreateFolder: async (name: string) => {
      setCreatingFolder(false);
      if (!(await guard([loc.path], "inside"))) return;
      ops.mkdir.mutate(name);
    },
    onCreateFolderCancel: () => setCreatingFolder(false),
    dropTarget: dragMove.drag?.over ?? null,
    parentDir: loc.path === "/" ? null : parentPath(loc.path),
    onOpenParent: () => setLoc({ ...loc, path: parentPath(loc.path) }),
  };

  // 트레이 메뉴(Rust)에서 넘어오는 동작
  useEffect(() => {
    if (!isTauri()) return;
    const actions: Record<string, () => void> = {
      upload: () => dropRef.current?.open(),
      refresh: () => void qc.invalidateQueries({ queryKey: ["dir"] }),
      settings: () => openSettings(),
      "send-settings": () => openSettings("send"),
      nearby: () => setNearbySend({ kind: "local" }),
      logout,
    };
    const off = import("@tauri-apps/api/event").then(({ listen }) => listen<string>("tray", (e) => actions[e.payload]?.()));
    return () => void off.then((f) => f());
  }, [qc, logout]);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background text-sm text-foreground">
      <TitleBar
        menu={{
          newFolder: () => setCreatingFolder(true),
          upload: () => dropRef.current?.open(),
          uploadFolder: isTauri() ? () => dropRef.current?.openFolder() : undefined,
          addSyncFolder: isTauri() ? sync.start : undefined,
          selection: { count: selectedEntries.length, hasFile: selectedEntries.some((e) => e.type === "file") },
          readOnly,
          hasLibrary: loc.libId !== null,
          download: () => ops.download.mutate(selectedEntries),
          share: () => selectedEntries[0] && setSharing(selectedEntries[0]),
          rename: () => selectedEntries[0] && setRenamingPath(selectedEntries[0].path),
          remove: () => void askDelete(selectedEntries),
          selectAll: () => setSelected(new Set(entries.map((x) => x.path))),
          clearSelection: () => setSelected(new Set()),
          view,
          setView,
          sidebarOpen,
          toggleSidebar: () => setSidebarOpen((v) => !v),
          detailsOpen,
          toggleDetails: () => setDetailsOpen((v) => !v),
          refresh: () => void qc.invalidateQueries({ queryKey: ["dir"] }),
          sort,
          setSort,
          back: () => go(-1),
          forward: () => go(1),
          up: () => setLoc({ ...loc, path: parentPath(loc.path) }),
          canBack,
          canForward,
          canUp: loc.libId !== null && loc.path !== "/",
          logout,
          settings: () => openSettings(),
          trash: openTrash,
          shareLinks: openLinks,
          nearby: isTauri() ? () => sendNearby() : undefined,
        }}
        crumbs={page === "links" ? [{ label: "공유 링크", path: loc.path }] : page === "trash" ? [{ label: `${lib?.name ?? ""} 휴지통`, path: loc.path }] : crumbs}
        onNavigate={(path) => setLoc({ ...loc, path })}
        onSearchPick={(libId, e) => {
          // 폴더는 안으로, 파일은 그 폴더로 가서 해당 파일을 선택
          if (e.type === "dir") setLoc({ libId, path: e.path });
          else {
            setLoc({ libId, path: parentPath(e.path) });
            setSelected(new Set([e.path]));
            setFocusPath(e.path);
          }
        }}
        disabled={!loc.libId || page !== "files"}
      />

      <div className="relative flex min-h-0 flex-1">
        {sidebarOpen && (
          <>
            <Sidebar
              width={sidebar.width}
              onTrash={openTrash}
              page={page}
              onShareLinks={openLinks}
              onSend={isTauri() ? () => sendNearby() : undefined}
              libraries={libs.data}
              loc={loc}
              onNavigate={setLoc}
              onRenameLibrary={(lib, newName) => renameLibrary.mutate({ lib, newName })}
              onStarLibrary={(lib, starred) => starLibrary.mutate({ lib, starred })}
            />
            {/* 사이드바 오른쪽 경계 위 4px 끌기 영역. 표 머리글의 열 조절과 같은 모양 */}
            <div role="separator" aria-orientation="vertical" onPointerDown={sidebar.startResize} className="group relative z-10 -ml-1 w-1 shrink-0 cursor-col-resize">
              <div className="absolute inset-y-0 right-0 w-px group-hover:bg-primary group-active:bg-primary" />
            </div>
          </>
        )}

        {/* 파일 목록 + 세부 정보 창. 미리보기는 이 자리를 덮는다 */}
        <div className="relative flex min-w-0 flex-1">
        <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
          {libs.error && <ErrorBanner message="저장소 목록을 불러오지 못했습니다" onRetry={() => libs.refetch()} />}
          {renameLibrary.error && <ErrorBanner message={`저장소 이름을 바꾸지 못했습니다 (${(renameLibrary.error as Error).message})`} actionLabel="닫기" onRetry={() => renameLibrary.reset()} />}
          {dir.error && <ErrorBanner message="폴더를 불러오지 못했습니다" onRetry={() => dir.refetch()} />}
          {ops.error && <ErrorBanner message={`${ops.error.message} (${ops.error.detail})`} actionLabel="닫기" onRetry={ops.error.reset} />}

          {page === "links" ? (
            <ShareLinksPage />
          ) : page === "trash" && loc.libId ? (
            <TrashPage libId={loc.libId} readOnly={readOnly} />
          ) : (
            <>
          <DropZone targetDir={loc.path} onFiles={onFiles} handle={dropRef} disabled={readOnly}>
            <BackgroundContextMenu
              disabled={loc.libId === null || creatingFolder || renamingPath !== null}
              onOpen={() => setSelected(new Set())}
              actions={{
                newFolder: () => setCreatingFolder(true),
                upload: () => dropRef.current?.open(),
                uploadFolder: isTauri() ? () => dropRef.current?.openFolder() : undefined,
                addSyncFolder: isTauri() ? sync.start : undefined,
                selectAll: () => setSelected(new Set(entries.map((x) => x.path))),
                refresh: () => void qc.invalidateQueries({ queryKey: ["dir"] }),
                view,
                setView,
                sort,
                setSort,
                readOnly,
              }}
              trigger={
                <div
                  ref={listRef}
                  tabIndex={0}
                  onKeyDown={onKeyDown}
                  onPointerDown={(e) => dragMove.onPointerDown(e) || marquee.onPointerDown(e)}
                  onClickCapture={(e) => (dragMove.onClickCapture(e), marquee.onClickCapture(e))}
                  onClick={(e) => e.target === e.currentTarget && setSelected(new Set())}
                  className="relative min-h-0 flex-1 overflow-auto outline-none"
                />
              }
            >
              {loc.libId === null ? (
                <Empty text="왼쪽에서 저장소를 선택하세요" />
              ) : dir.isLoading ? (
                <FileListSkeleton />
              ) : (
                <>
                  {/* 빈 폴더라도 하위 폴더면 목록을 그려 상위 폴더(..) 줄을 남긴다 */}
                  {(entries.length > 0 || creatingFolder || listProps.parentDir != null) &&
                    (view === "grid" ? <IconGrid {...listProps} libId={loc.libId} iconSize={iconSize} /> : <FileList {...listProps} />)}
                  {entries.length === 0 && !creatingFolder && (
                    <Empty text={readOnly ? "비어 있는 폴더입니다" : "비어 있는 폴더입니다. 파일을 끌어다 놓으세요"} className={listProps.parentDir != null ? "h-auto py-16" : undefined} />
                  )}
                </>
              )}
              {marquee.rect && <div className="pointer-events-none absolute border border-primary/60 bg-primary/10" style={marquee.rect} />}
              {dragMove.drag && (
                <div className="pointer-events-none fixed z-50 rounded-md bg-popover px-2 py-1 text-xs shadow-dialog" style={{ left: dragMove.drag.x + 14, top: dragMove.drag.y + 14 }}>
                  {dragMove.drag.over ? `'${dirName(dragMove.drag.over)}'(으)로 옮기기` : `${dragMove.drag.count}개 항목`}
                </div>
              )}
            </BackgroundContextMenu>
          </DropZone>
            </>
          )}
        </main>
        {detailsOpen && page === "files" && (
          <DetailsPanel libId={loc.libId} libName={lib?.name ?? ""} folderName={crumbs[crumbs.length - 1]?.label ?? ""} root={loc.path === "/"} entries={dir.data ?? []} selected={selectedEntries} sharedPaths={sharedPaths} syncLinks={syncLinks} />
        )}
        {loc.libId && page === "files" && (
          <PreviewModal libId={loc.libId} entries={previewable} index={previewIndex} onClose={closePreview} onNavigate={(i) => setPreviewPath(previewable[i]?.path ?? null)} onDownload={(e) => ops.download.mutate([e])} />
        )}
        </div>
        {/* 알림(새 버전·다운로드·업로드)은 세부 정보 창이 있어도 창 오른쪽 아래 가장자리에 */}
        <div className="pointer-events-none absolute right-3 bottom-3 z-20 flex flex-col items-end gap-2 *:pointer-events-auto">
          <UpdateNotice />
          {lastMove && <MoveNotice op={lastMove} dstName={dirName(lastMove.dstDir)} onUndo={undoMove} onClose={closeMoveNotice} />}
          <DownloadPanel />
          <UploadPanel />
          <NearbyPanel />
        </div>
      </div>

      <StatusBar
        itemCount={page === "files" && dir.data ? dir.data.length : null}
        note={page === "links" ? (shareLinks.data ? `링크 ${shareLinks.data.length}개` : "") : readOnly && dir.data ? `${dir.data.length}개 항목 · ${syncReadOnly ? "동기화 폴더 · 읽기 전용" : "읽기 전용"}` : syncNote ? (page === "files" && dir.data ? `${dir.data.length}개 항목 · ${syncNote}` : syncNote) : undefined}
        onNoteClick={page === "files" && !(readOnly && dir.data) && problem.length > 0 ? () => setLoc({ libId: problem[0].libId, path: problem[0].drivePath }) : undefined}
        selectedCount={selectedEntries.length}
        selectedBytes={selectedEntries.reduce((a, e) => a + e.size, 0)}
      />

      {loc.libId && <ShareDialog libId={loc.libId} entry={sharing} onClose={() => setSharing(null)} />}
      <SendDialog source={nearbySend} onClose={() => setNearbySend(null)} />
      <SettingsDialog open={settingsOpen} page={settingsPage} onClose={() => setSettingsOpen(false)} />
      {sync.dialog}
      <UnsyncDialog
        open={!!unsyncing}
        onCancel={() => setUnsyncing(null)}
        onConfirm={async () => {
          const l = unsyncing;
          setUnsyncing(null);
          if (!l) return;
          // 감시를 풀고 기준 기록을 지운 뒤 연결을 없앤다. 실패해도 연결은 없앤다
          await unwatchFolder(l.id).catch(() => {});
          await deleteBaseline(l.id).catch(() => {});
          removeLink(l.id);
          releaseHold(l.id);
        }}
      />
      {guardDialog}
      <OverwriteDialog count={pending?.conflicts.length ?? 0} onChoice={onOverwriteChoice} />
      <DeleteDialog
        entries={deleting}
        onCancel={() => setDeleting([])}
        onConfirm={() => {
          for (const e of deleting) ops.remove.mutate(e);
          setDeleting([]);
          setSelected(new Set());
        }}
      />
    </div>
  );
}

function Empty({ text, className }: { text: string; className?: string }) {
  return <div className={cn("flex h-full items-center justify-center text-sm text-muted-foreground", className)}>{text}</div>;
}

function ErrorBanner({ message, onRetry, actionLabel = "다시 시도" }: { message: string; onRetry(): void; actionLabel?: string }) {
  return (
    <div className="flex shrink-0 items-center justify-between gap-2 border-b border-destructive/30 bg-destructive/10 px-3 py-1.5 text-sm text-destructive">
      <span className="truncate">{message}</span>
      <Button variant="outline" size="xs" onClick={onRetry}>
        {actionLabel}
      </Button>
    </div>
  );
}
