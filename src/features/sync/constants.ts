import type { SyncStatus } from "./type";

export const SETTLE_SEC = 3;
export const FULL_SCAN_MS = 3_600_000;
export const MASS_DELETE_MIN = 10;
export const MASS_DELETE_RATIO = 0.5;
export const MASS_DELETE_MAX = 500;

/** 사용자가 손봐야 하는 상태(배지 색·상태 표시줄) */
export const isSyncProblem = (s: SyncStatus) => s === "localMissing" || s === "driveMissing" || s === "error" || s === "needsConfirm";
