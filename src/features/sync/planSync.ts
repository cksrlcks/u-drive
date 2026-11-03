import { MASS_DELETE_MAX, MASS_DELETE_MIN, MASS_DELETE_RATIO, SETTLE_SEC } from "./constants";
import type { Baseline, Scan, SyncPlan } from "./type";

const depth = (p: string) => p.split("/").length;

export function emptyBaseline(): Baseline {
  return { files: {}, dirs: [] };
}

export function planSync(scan: Scan, base: Baseline, opts: { nowSec: number; fresh: boolean; confirmedDeletes?: boolean }): SyncPlan {
  const changed = scan.files.filter((f) => {
    const b = base.files[f.rel];
    return !b || b.size !== f.size || b.mtime !== f.mtime;
  });
  // 방금 바뀐 파일은 쓰는 중일 수 있어 다음 차례로 미룬다. 미래 시각(시계가 앞선 NAS·USB)은 영원히 미뤄지지 않게 바로 올린다
  const uploads = changed.filter((f) => {
    const age = opts.nowSec - f.mtime;
    return age < 0 || age >= SETTLE_SEC;
  });
  const baseDirs = new Set(base.dirs);
  const scanDirs = new Set(scan.dirs);
  const scanFiles = new Set(scan.files.map((f) => f.rel));
  const mkdirs = scan.dirs.filter((d) => !baseDirs.has(d)).sort((a, b) => depth(a) - depth(b));
  // 못 읽은 곳 아래는 "없어진 것"이 아니라 "모르는 것"이라 지우지 않는다("" = 루트 전체)
  const unknown = (r: string) => scan.unreadable.some((u) => u === "" || r === u || r.startsWith(u + "/"));
  const removeFiles = opts.fresh ? [] : Object.keys(base.files).filter((r) => !scanFiles.has(r) && !unknown(r));
  const removeDirs = opts.fresh ? [] : base.dirs.filter((d) => !scanDirs.has(d) && !unknown(d)).sort((a, b) => depth(b) - depth(a));
  const baseCount = Object.keys(base.files).length;
  const massDelete =
    !opts.confirmedDeletes &&
    (removeFiles.length > MASS_DELETE_MAX || (removeFiles.length >= MASS_DELETE_MIN && removeFiles.length >= baseCount * MASS_DELETE_RATIO));
  return { uploads, mkdirs, removeFiles, removeDirs, deferred: changed.length - uploads.length, massDelete };
}
