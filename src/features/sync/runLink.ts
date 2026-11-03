import { logError } from "@/lib/errorLog";
import { waitSettled } from "@/features/mcp/waitSettled";
import type { UploadQueue } from "@/features/upload/uploadQueue";
import { joinPath } from "@/storage/path";
import { StorageError, type StorageProvider, type UploadTask } from "@/storage/StorageProvider";
import { emptyBaseline, planSync } from "./planSync";
import type { Baseline, Scan, SyncLink } from "./type";

export type RunDeps = {
  storage: Pick<StorageProvider, "listDir" | "mkdir" | "remove">;
  uploads: Pick<UploadQueue, "add" | "subscribe" | "getSnapshot">;
  scan(root: string): Promise<Scan | "NOT_FOUND">;
  readBase(id: string): Promise<Baseline | null>;
  writeBase(id: string, b: Baseline): Promise<void>;
  nowSec(): number;
  onPending?(n: number): void;
};
export type RunResult =
  | { status: "idle"; deferred: number } // deferred > 0 이면 호출 쪽이 SETTLE_SEC 뒤 다시 부른다
  | { status: "localMissing" | "driveMissing" }
  | { status: "needsConfirm"; deleteCount: number };

const isKind = (e: unknown, kind: StorageError["kind"]) => e instanceof StorageError && e.kind === kind;
const dirOf = (rel: string) => (rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "");

export async function runLink(link: SyncLink, deps: RunDeps, opts: { confirmedDeletes?: boolean } = {}): Promise<RunResult> {
  const { storage, uploads } = deps;
  const scan = await deps.scan(link.localRoot);
  if (scan === "NOT_FOUND") return { status: "localMissing" };
  try {
    await storage.listDir(link.libId, link.drivePath);
  } catch (e) {
    if (isKind(e, "notFound")) return { status: "driveMissing" };
    throw e;
  }
  const base = (await deps.readBase(link.id)) ?? emptyBaseline();
  const plan = planSync(scan, base, { nowSec: deps.nowSec(), fresh: link.fresh, confirmedDeletes: opts.confirmedDeletes });
  if (plan.massDelete) return { status: "needsConfirm", deleteCount: plan.removeFiles.length };

  const files = { ...base.files };
  const dirs = new Set(base.dirs);
  const drive = (rel: string) => joinPath(link.drivePath, rel);
  try {
    // 상위 폴더가 드라이브에서 지워졌으면 먼저 만든다(mkdir은 중간 폴더를 안 만든다)
    const ensureDir = async (d: string): Promise<void> => {
      const parent = dirOf(d);
      const name = d.slice(parent ? parent.length + 1 : 0);
      let siblings: Awaited<ReturnType<typeof storage.listDir>> = [];
      try {
        siblings = await storage.listDir(link.libId, parent ? drive(parent) : link.drivePath);
      } catch (e) {
        if (!parent || !isKind(e, "notFound")) throw e;
        await ensureDir(parent);
      }
      if (!siblings.some((s) => s.type === "dir" && s.name === name)) await storage.mkdir(link.libId, drive(d));
    };
    for (const d of plan.mkdirs) {
      await ensureDir(d);
      dirs.add(d);
    }

    if (plan.uploads.length) {
      const tasks: UploadTask[] = plan.uploads.map((f) => {
        const file = { name: f.rel.slice(f.rel.lastIndexOf("/") + 1), size: f.size, lastModified: f.mtime * 1000, localPath: f.path };
        const relativePath = dirOf(f.rel);
        return relativePath ? { file, targetDir: link.drivePath, relativePath } : { file, targetDir: link.drivePath };
      });
      const ids = uploads.add(link.libId, tasks);
      const isSettled = (s: string) => s === "done" || s === "failed" || s === "cancelled";
      deps.onPending?.(ids.length);
      const off = uploads.subscribe((items) => deps.onPending?.(ids.filter((id) => { const it = items.find((i) => i.id === id); return it && !isSettled(it.status); }).length));
      const done = await waitSettled(uploads, ids, isSettled).finally(off);
      deps.onPending?.(0);
      done.forEach((it, i) => {
        if (it.status !== "done") return;
        const f = plan.uploads[i];
        files[f.rel] = { size: f.size, mtime: f.mtime };
        // 업로드로 생긴 상위 폴더도 기준 상태에 넣는다
        for (let d = dirOf(f.rel); d; d = dirOf(d)) dirs.add(d);
      });
    }

    for (const rel of plan.removeFiles) {
      try {
        await storage.remove(link.libId, drive(rel), "file");
        delete files[rel];
      } catch (e) {
        if (isKind(e, "notFound")) delete files[rel];
        else if (isKind(e, "unauthorized")) throw e;
        else logError("sync", e);
      }
    }

    for (const d of plan.removeDirs) {
      try {
        // 사용자가 드라이브에서 직접 넣은 파일이 있으면 지우지 않는다
        if ((await storage.listDir(link.libId, drive(d))).length === 0) await storage.remove(link.libId, drive(d), "dir");
        dirs.delete(d);
      } catch (e) {
        if (isKind(e, "notFound")) dirs.delete(d);
        else if (isKind(e, "unauthorized")) throw e;
        else logError("sync", e);
      }
    }
  } finally {
    await deps.writeBase(link.id, { files, dirs: [...dirs] });
  }
  return { status: "idle", deferred: plan.deferred };
}
