import { useSyncExternalStore } from "react";
import { getPrefs } from "@/features/settings/appPrefs";
import { isTauri } from "@/features/shell/platform";
import type { Entry } from "@/storage/StorageProvider";
import { DownloadQueue, type DownloadItem, type DownloadJob, type Saver } from "./downloadQueue";

/** Tauri: upload 플러그인이 디스크로 스트리밍(대용량도 메모리에 안 올림). 진행 이벤트는 100ms에 한 번만 반영. */
const tauriSaver: Saver = async (url, path, onProgress) => {
  const { download } = await import("@tauri-apps/plugin-upload");
  let last = 0;
  await download(url, path, (p) => {
    const now = performance.now();
    if (now - last < 100) return;
    last = now;
    onProgress(p.progressTotal, p.total);
  });
};

/** 앱 전체에서 하나. 업로드 큐와 달리 저장소(Provider)와 무관하게 로컬 디스크 작업이라 전역으로 둔다. */
export const downloads = new DownloadQueue(tauriSaver);

export function useDownloads(): DownloadItem[] {
  return useSyncExternalStore(downloads.subscribe, downloads.getSnapshot);
}

/** 브라우저 모드: 브라우저 다운로드로 넘긴다 */
function browserDownload(url: string, name: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * 설정에 다운로드 폴더가 있으면 묻지 않고 그 폴더에 받는다(같은 이름이 있으면 번호를 붙임).
 * 없으면 파일 1개는 "다른 이름으로 저장", 여러 개는 폴더 선택 후 그 폴더에 같은 이름으로 받는다.
 * 사용자가 대화상자를 취소하면 아무것도 하지 않는다(false 반환).
 */
export async function downloadEntries(entries: Entry[], getUrl: (e: Entry) => Promise<string>, listDir?: (path: string) => Promise<Entry[]>): Promise<boolean> {
  if (listDir && isTauri() && entries.some((e) => e.type === "dir")) return downloadTree(entries, getUrl, listDir);
  const files = entries.filter((e) => e.type === "file");
  if (files.length === 0) return false;

  if (!isTauri()) {
    for (const f of files) browserDownload(await getUrl(f), f.name);
    return true;
  }

  const fixed = getPrefs().downloadDir;
  if (fixed) {
    const { invoke } = await import("@tauri-apps/api/core");
    // ponytail: 디스크에 있는 이름만 피한다. 같은 파일을 아직 시작 전인 큐에 또 넣으면 겹칠 수 있음 — 문제 되면 큐의 path도 함께 확인
    const targets = await Promise.all(files.map((f) => invoke<string>("free_path", { dir: fixed, name: f.name })));
    downloads.add(files.map((f, i) => ({ name: f.name, size: f.size, url: () => getUrl(f), path: targets[i] })));
    return true;
  }

  const { save, open } = await import("@tauri-apps/plugin-dialog");
  const { join, downloadDir } = await import("@tauri-apps/api/path");
  const base = await downloadDir().catch(() => undefined);

  let targets: string[];
  if (files.length === 1) {
    const path = await save({ title: "다른 이름으로 저장", defaultPath: base ? await join(base, files[0].name) : files[0].name });
    if (!path) return false;
    targets = [path];
  } else {
    const dir = await open({ title: `${files.length}개 파일을 저장할 폴더`, directory: true, defaultPath: base });
    if (!dir || Array.isArray(dir)) return false;
    targets = await Promise.all(files.map((f) => join(dir, f.name)));
  }

  downloads.add(files.map((f, i) => ({ name: f.name, size: f.size, url: () => getUrl(f), path: targets[i] })));
  return true;
}

/**
 * 폴더가 섞인 받기(앱 전용). 다운로드 폴더(설정 또는 선택) 아래에 폴더 구조 그대로 받는다.
 * 같은 이름의 폴더·파일이 디스크에 있으면 free_path가 "이름 (1)"로 피하고, 하위 폴더도 만들어 준다.
 */
// ponytail: 빈 하위 폴더는 만들지 않음(파일이 있는 폴더만 생김). 필요하면 Rust에 mkdir 커맨드 추가
async function downloadTree(entries: Entry[], getUrl: (e: Entry) => Promise<string>, listDir: (path: string) => Promise<Entry[]>): Promise<boolean> {
  let base = getPrefs().downloadDir;
  if (!base) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const { downloadDir } = await import("@tauri-apps/api/path");
    const dir = await open({ title: "받을 폴더", directory: true, defaultPath: await downloadDir().catch(() => undefined) });
    if (!dir || Array.isArray(dir)) return false;
    base = dir;
  }
  const { invoke } = await import("@tauri-apps/api/core");
  const jobs: DownloadJob[] = [];
  // 순서대로 훑는다: 폴더 경로를 정하자마자 하위 파일의 free_path가 그 폴더를 만들어, 다음 형제와 겹치지 않는다
  const walk = async (e: Entry, dir: string): Promise<void> => {
    const path = await invoke<string>("free_path", { dir, name: e.name });
    if (e.type === "file") jobs.push({ name: e.name, size: e.size, url: () => getUrl(e), path });
    else for (const c of await listDir(e.path)) await walk(c, path);
  };
  for (const e of entries) await walk(e, base);
  downloads.add(jobs);
  return true;
}

export async function revealInFolder(path: string) {
  const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
  await revealItemInDir(path);
}
