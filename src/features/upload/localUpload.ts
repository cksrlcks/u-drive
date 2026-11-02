import type { PathFile, UploadTask } from "@/storage/StorageProvider";

/** Rust list_upload_files 결과. dir = 고른 항목 기준 하위 폴더("" 또는 "사진/2026") */
export type LocalUploadFile = { path: string; name: string; dir: string; size: number; mtime: number };

export function toLocalTasks(files: LocalUploadFile[], targetDir: string): UploadTask[] {
  return files.map((f) => {
    const file: PathFile = { name: f.name, size: f.size, lastModified: Math.round(f.mtime * 1000), localPath: f.path };
    return f.dir ? { file, targetDir, relativePath: f.dir } : { file, targetDir };
  });
}

/** PC의 파일·폴더 경로들을 업로드 작업으로. 폴더는 하위 구조를 그대로 올린다 */
export async function localTasks(paths: string[], targetDir: string): Promise<UploadTask[]> {
  const { invoke } = await import("@tauri-apps/api/core");
  return toLocalTasks(await invoke<LocalUploadFile[]>("list_upload_files", { paths }), targetDir);
}

/** 폴더 선택 창. 취소하면 null */
export async function pickFolder(): Promise<string | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  return open({ title: "업로드할 폴더", directory: true });
}
