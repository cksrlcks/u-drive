import { StorageError, type Account, type Entry, type Library, type StorageProvider, type TrashEntry, type UploadTask } from "../StorageProvider";
import type { DeviceInfo } from "../device";
import { sliceOf } from "../localFile";
import { joinPath } from "../path";
import { CHUNK_SIZE, chunkRanges } from "../chunk";
import { xhrRequest } from "../xhrUpload";
import { WapleApi } from "./api";

interface LibraryDto { id: string; name: string; size: number; mtime: number; head_commit_id: string; section: "own" | "shared"; starred: boolean; permission: "rw" | "r"; encrypted?: boolean }
interface TrashDto { name: string; type: "file" | "dir"; size: number; parent_dir: string; deleted_at: number; commit_id: string }
interface SessionDto { session_id: string; received_bytes: number }

const aborted = () => new DOMException("aborted", "AbortError");

/** Waple Drive 서버용 StorageProvider. 서버 응답(snake_case)을 앱 타입으로 바꾸는 일만 한다. */
export class WapleProvider implements StorageProvider {
  private _token: string | null;
  private api: WapleApi;

  constructor(baseUrl: string, initialToken: string | null) {
    this._token = initialToken;
    this.api = new WapleApi(baseUrl, () => this._token);
  }

  get token(): string | null {
    return this._token;
  }

  isLoggedIn(): boolean {
    return this._token !== null;
  }

  async login(username: string, password: string, _otp?: string, device?: DeviceInfo | null): Promise<void> {
    const body: Record<string, unknown> = { email: username, password };
    if (device) body.device = { platform: device.platform, device_id: device.deviceId, device_name: device.deviceName, client_version: device.clientVersion };
    const res = await this.api.postJson<{ token: string }>("/api/v1/auth/login", body);
    this._token = res.token;
  }

  /** 서버의 기기 토큰도 지운다. 서버에 닿지 않아도 로컬 로그아웃은 그대로 */
  async logout(): Promise<void> {
    if (this._token) await this.api.postJson("/api/v1/auth/logout").catch(() => undefined);
    this._token = null;
  }

  getAccount(): Promise<Account> {
    return this.api.get<Account>("/api/v1/me");
  }

  async listGroups(): Promise<string[]> {
    return (await this.api.get<{ name: string }[]>("/api/v1/me/groups")).map((g) => g.name);
  }

  async listLibraries(): Promise<Library[]> {
    const rows = await this.api.get<LibraryDto[]>("/api/v1/repos");
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      size: r.size,
      mtime: r.mtime,
      encrypted: r.encrypted ?? false,
      headCommitId: r.head_commit_id,
      section: r.section === "own" ? "내 저장소" : "나에게 공유됨",
      starred: r.starred,
      readOnly: r.permission === "r",
    }));
  }

  async renameLibrary(libId: string, newName: string): Promise<void> {
    await this.api.patchJson(`/api/v1/repos/${libId}`, { name: newName });
  }

  async starLibrary(libId: string, starred: boolean): Promise<void> {
    if (starred) await this.api.put(`/api/v1/repos/${libId}/star`);
    else await this.api.delete(`/api/v1/repos/${libId}/star`);
  }

  async listDir(libId: string, path: string): Promise<Entry[]> {
    const items = await this.api.get<Entry[]>(`/api/v1/repos/${libId}/dir`, { path });
    return items.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
  }

  listTree(libId: string): Promise<Entry[]> {
    return this.api.get<Entry[]>(`/api/v1/repos/${libId}/tree`);
  }

  /**
   * 업로드 프로토콜 v1: 세션을 열고(같은 파일이면 서버가 받은 바이트를 알려 준다) 조각을 PUT 한다.
   * 작은 파일은 Content-Range 없이 한 번. 409 는 서버가 준 received_bytes 로 한 번 다시 맞춘다.
   */
  async upload(libId: string, task: UploadTask, onProgress: (sent: number, total: number) => void, signal?: AbortSignal): Promise<void> {
    const { file, targetDir, relativePath } = task;
    const size = file.size;
    const throwIfAborted = () => {
      if (signal?.aborted) throw aborted();
    };
    throwIfAborted();

    const body: Record<string, unknown> = { parent_dir: targetDir, file_name: file.name, size, replace: true, mtime: Math.floor(file.lastModified / 1000) };
    if (relativePath) body.relative_path = relativePath;
    const session = await this.api.postJson<SessionDto>(`/api/v1/repos/${libId}/upload-sessions`, body, undefined, signal);
    const url = this.api.url(`/api/v1/upload-sessions/${session.session_id}`);
    const progress = (sent: number) => onProgress(Math.min(sent, size), size);

    const put = (blob: Blob, start: number, range?: string) =>
      xhrRequest("PUT", url, blob, { ...this.api.headers(), ...(range ? { "Content-Range": range } : {}) }, (sent) => progress(start + sent), signal);
    const send = async (start: number, end: number, range: boolean) =>
      put(await sliceOf(file, start, end), start, range ? `bytes ${start}-${end - 1}/${size}` : undefined);

    let received = session.received_bytes;
    let resynced = false;
    for (;;) {
      throwIfAborted();
      try {
        if (received >= size && size > 0) {
          // 바이트는 다 받았는데 커밋이 안 끝난 세션(앞선 시도가 커밋 직전에 끊김): 빈 PUT 으로 커밋만 시킨다
          await put(new Blob([]), 0, `bytes 0-${size - 1}/${size}`);
        } else {
          const ranges = chunkRanges(size, received, CHUNK_SIZE);
          if (ranges.length === 0) await send(0, size, false);
          for (const { start, end } of ranges) {
            throwIfAborted();
            await send(start, end + 1, true);
            progress(end + 1);
          }
        }
        progress(size);
        return;
      } catch (e) {
        const again = receivedFrom409(e);
        if (again === null || resynced || signal?.aborted) throw e;
        resynced = true;
        received = again;
      }
    }
  }

  async downloadUrl(libId: string, path: string): Promise<string> {
    const r = await this.api.postJson<{ url: string }>(`/api/v1/repos/${libId}/file/link`, undefined, { path });
    return r.url;
  }

  previewUrl(libId: string, path: string): Promise<string> {
    return this.downloadUrl(libId, path);
  }

  async readText(libId: string, path: string): Promise<string> {
    const url = await this.previewUrl(libId, path);
    const res = await fetch(url);
    if (!res.ok) throw new StorageError("server", res.statusText, res.status);
    const buf = await res.arrayBuffer();
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(buf);
    } catch {
      return new TextDecoder("euc-kr").decode(buf); // 레거시 한글 txt (CP949)
    }
  }

  thumbnail(libId: string, path: string, size: number, signal?: AbortSignal): Promise<Blob> {
    return this.api.getBlob(`/api/v1/repos/${libId}/thumbnail`, { path, size: String(size) }, signal);
  }

  async mkdir(libId: string, path: string): Promise<void> {
    await this.api.postJson(`/api/v1/repos/${libId}/dir`, undefined, { path });
  }

  async rename(libId: string, path: string, newName: string, _type: "file" | "dir"): Promise<void> {
    await this.api.postJson(`/api/v1/repos/${libId}/rename`, { path, new_name: newName });
  }

  async remove(libId: string, path: string, _type: "file" | "dir"): Promise<void> {
    await this.api.delete(`/api/v1/repos/${libId}/entry`, { path });
  }

  async move(libId: string, srcDir: string, names: string[], dstDir: string): Promise<void> {
    await this.api.postJson(`/api/v1/repos/${libId}/move`, { src_dir: srcDir, names, dst_dir: dstDir });
  }

  async listTrash(libId: string): Promise<TrashEntry[]> {
    const rows = await this.api.get<TrashDto[]>(`/api/v1/repos/${libId}/trash`);
    return rows.map((d) => ({ name: d.name, type: d.type, size: d.size, parentDir: d.parent_dir, deletedAt: d.deleted_at, commitId: d.commit_id }));
  }

  async restoreTrash(libId: string, e: TrashEntry): Promise<void> {
    await this.api.postJson(`/api/v1/repos/${libId}/trash/restore`, { commit_id: e.commitId, path: joinPath(e.parentDir, e.name) });
  }

  async emptyTrash(libId: string): Promise<void> {
    await this.api.delete(`/api/v1/repos/${libId}/trash`);
  }
}

/** 409 "이어 올리기 위치가 다릅니다" 의 received_bytes. 아니면 null */
function receivedFrom409(e: unknown): number | null {
  if (!(e instanceof StorageError) || e.status !== 409) return null;
  try {
    const j = JSON.parse(e.message) as { received_bytes?: number };
    return typeof j.received_bytes === "number" ? j.received_bytes : null;
  } catch {
    return null;
  }
}

