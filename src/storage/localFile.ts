import type { PathFile } from "./StorageProvider";

/** 업로드할 [start, end) 구간. 디스크 경로 파일은 앱(Rust)에서 그 구간만 읽는다 */
export async function sliceOf(file: File | PathFile, start: number, end: number): Promise<Blob> {
  if (!("localPath" in file)) return file.slice(start, end);
  const { invoke } = await import("@tauri-apps/api/core");
  return new Blob([await invoke<ArrayBuffer>("read_local_range", { path: file.localPath, start, len: end - start })]);
}
