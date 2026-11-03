export type ScanFile = { rel: string; path: string; size: number; mtime: number }; // mtime: 유닉스 초
export type Scan = { files: ScanFile[]; dirs: string[]; totalBytes: number; unreadable: string[] };
export type Baseline = { files: Record<string, { size: number; mtime: number }>; dirs: string[] };
export type SyncLink = {
  id: string; // crypto.randomUUID()
  account: string; // `${baseUrl}|${email}`
  libId: string;
  drivePath: string; // 연결된 드라이브 폴더, '/'로 시작
  localRoot: string; // PC 폴더 절대 경로
  paused: boolean;
  fresh: boolean; // 기존 폴더에 이어서 연결: 첫 동기화에서 지우지 않는다
};
export type SyncStatus = "idle" | "syncing" | "paused" | "needsConfirm" | "localMissing" | "driveMissing" | "error";
export type LinkState = { status: SyncStatus; pending: number; lastSyncedAt: number | null; error?: string; deleteCount?: number };
export type SyncPlan = { uploads: ScanFile[]; mkdirs: string[]; removeFiles: string[]; removeDirs: string[]; deferred: number; massDelete: boolean };
