import { logError } from "@/lib/errorLog";
import { waitSettled } from "@/features/mcp/waitSettled";
import type { UploadQueue } from "@/features/upload/uploadQueue";
import { joinPath } from "@/storage/path";
import { StorageError, type StorageProvider, type UploadTask } from "@/storage/StorageProvider";
import { SETTLE_SEC } from "./constants";
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
  sleep?(ms: number): Promise<void>; // 테스트에서 바꿔 끼운다
};
export type RunResult =
  | { status: "idle"; deferred: number } // deferred > 0 이면 호출 쪽이 SETTLE_SEC 뒤 다시 부른다
  | { status: "localMissing" | "driveMissing" }
  | { status: "needsConfirm"; deleteCount: number };

const isKind = (e: unknown, kind: StorageError["kind"]) => e instanceof StorageError && e.kind === kind;
const dirOf = (rel: string) => (rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "");
/** 한 번에 큐에 넣는 업로드 수. 묶음마다 기준 상태를 저장해 앱이 중간에 꺼져도 올린 것은 잊지 않는다 */
const BATCH = 200;
const isSettled = (s: string) => s === "done" || s === "failed" || s === "cancelled";

/** signal이 중단되면(연결 해제·일시정지·로그아웃) 더 지우거나 올리지 않고, 기준 상태도 쓰지 않는다(지운 기준 상태 파일을 되살리지 않게) */
export async function runLink(link: SyncLink, deps: RunDeps, opts: { confirmedDeletes?: boolean; signal?: AbortSignal } = {}): Promise<RunResult> {
  const { storage, uploads } = deps;
  const aborted = () => !!opts.signal?.aborted;
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
  const idle: RunResult = { status: "idle", deferred: plan.deferred };

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

    // 진행 알림마다 부르지 않고 남은 수가 바뀔 때만 알린다
    let shown = -1;
    const report = (n: number) => n !== shown && deps.onPending?.((shown = n));
    for (let start = 0; start < plan.uploads.length; start += BATCH) {
      if (aborted()) return idle;
      const batch = plan.uploads.slice(start, start + BATCH);
      const tasks: UploadTask[] = batch.map((f) => {
        const file = { name: f.rel.slice(f.rel.lastIndexOf("/") + 1), size: f.size, lastModified: f.mtime * 1000, localPath: f.path };
        const relativePath = dirOf(f.rel);
        return relativePath ? { file, targetDir: link.drivePath, relativePath } : { file, targetDir: link.drivePath };
      });
      const ids = uploads.add(link.libId, tasks);
      const mine = new Set(ids);
      const later = plan.uploads.length - start - batch.length;
      report(later + ids.length);
      const off = uploads.subscribe((items) => {
        let n = 0;
        for (const it of items) if (mine.has(it.id) && !isSettled(it.status)) n++;
        report(later + n);
      });
      const done = await waitSettled(uploads, ids, isSettled).finally(off);
      if (aborted()) return idle;
      done.forEach((it, i) => {
        if (it.status !== "done") return;
        const f = batch[i];
        files[f.rel] = { size: f.size, mtime: f.mtime };
        // 업로드로 생긴 상위 폴더도 기준 상태에 넣는다
        for (let d = dirOf(f.rel); d; d = dirOf(d)) dirs.add(d);
      });
      await deps.writeBase(link.id, { files, dirs: [...dirs] });
    }
    if (plan.uploads.length) report(0);

    let { removeFiles, removeDirs } = plan;
    if (removeFiles.length || removeDirs.length) {
      // 저장 중(Word 등) 잠깐 없어진 파일을 지우지 않게, 잠시 뒤 다시 훑어 두 번 다 없는 것만 지운다
      await (deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms))))(SETTLE_SEC * 1000);
      if (aborted()) return idle;
      const again = await deps.scan(link.localRoot);
      if (again === "NOT_FOUND") return { status: "localMissing" };
      const still = planSync(again, base, { nowSec: deps.nowSec(), fresh: link.fresh, confirmedDeletes: true });
      const goneFiles = new Set(still.removeFiles);
      const goneDirs = new Set(still.removeDirs);
      removeFiles = removeFiles.filter((r) => goneFiles.has(r));
      removeDirs = removeDirs.filter((d) => goneDirs.has(d));
    }

    for (const rel of removeFiles) {
      if (aborted()) return idle;
      try {
        await storage.remove(link.libId, drive(rel), "file");
        delete files[rel];
      } catch (e) {
        if (isKind(e, "notFound")) delete files[rel];
        else if (isKind(e, "unauthorized")) throw e;
        else logError("sync", e);
      }
    }

    for (const d of removeDirs) {
      if (aborted()) return idle;
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
    if (!aborted()) await deps.writeBase(link.id, { files, dirs: [...dirs] });
  }
  return idle;
}
