import { StorageError, type Account, type Entry, type Library, type ShareLink, type ShareLinkInfo, type StorageProvider, type TrashEntry, type UploadTask } from "../StorageProvider";
import { joinPath } from "../path";
import type { DeviceInfo } from "../device";
import { SeafileApi } from "./api";
import { CHUNK_SIZE, chunkRanges } from "../chunk";
import { sliceOf } from "../localFile";
import { clearInterrupted, isInterrupted, markInterrupted } from "./resumeRegistry";
import { xhrUpload } from "../xhrUpload";

interface RepoDto { id: string; name: string; size: number; mtime: number; encrypted: boolean; head_commit_id?: string; type?: "repo" | "srepo" | "grepo"; group_name?: string; permission?: string }
interface DirentDto { id: string; name: string; type: "file" | "dir"; size?: number; mtime: number }
interface TreeDirentDto { type: "file" | "dir"; id: string; name: string; parent_dir: string; size?: number; mtime: string | number }
interface ShareLinkDto { token: string; link: string; repo_id: string; repo_name: string; path: string; obj_name: string; is_dir: boolean; expire_date: string | null; is_expired: boolean; is_encrypted?: boolean; password?: string | null; view_cnt: number; ctime: string }
interface TrashDto { obj_name: string; parent_dir: string; is_dir: boolean; size?: number; deleted_time: string; commit_id: string }

function isLinkExpired(e: unknown): boolean {
  const status = (e as { status?: number }).status;
  return status === 403 || status === 500;
}

export class SeafileProvider implements StorageProvider {
  private _token: string | null;
  protected api: SeafileApi;

  constructor(baseUrl: string, initialToken: string | null) {
    this._token = initialToken;
    this.api = new SeafileApi(baseUrl, () => this._token);
  }

  get token(): string | null {
    return this._token;
  }

  /** device가 있으면 기기별 토큰(TokenV2): 서버의 '연결된 기기'에 이 PC가 따로 보이고 따로 끊을 수 있다 */
  async login(username: string, password: string, otp?: string, device?: DeviceInfo | null): Promise<void> {
    const form: Record<string, string> = { username, password };
    if (device) Object.assign(form, { platform: device.platform, device_id: device.deviceId, device_name: device.deviceName, client_version: device.clientVersion });
    const res = await this.api.postForm<{ token: string }>("/api2/auth-token/", form, undefined, otp ? { "X-SEAFILE-OTP": otp } : undefined);
    this._token = res.token;
  }

  /** 서버에서도 이 토큰을 지운다(logout-device). 서버에 닿지 않아도 로컬 로그아웃은 그대로 */
  async logout(): Promise<void> {
    if (this._token) await this.api.postForm("/api2/logout-device/", {}).catch(() => undefined);
    this._token = null;
  }

  isLoggedIn(): boolean {
    return this._token !== null;
  }

  async getAccount(): Promise<Account> {
    const r = await this.api.get<{ email: string; contact_email?: string; name?: string; usage: number; total: number }>("/api2/account/info/");
    // email은 내부 ID(…@auth.local)일 수 있다. 사람이 아는 이메일은 contact_email
    const email = r.contact_email || r.email;
    return { email, name: r.name || email, usage: r.usage, quota: r.total > 0 ? r.total : null };
  }

  async listGroups(): Promise<string[]> {
    const r = await this.api.get<{ name: string }[]>("/api/v2.1/groups/");
    return r.map((g) => g.name);
  }

  async listLibraries(): Promise<Library[]> {
    // 같은 저장소가 소유(repo)·공유(srepo)·그룹(grepo)으로 여러 번 온다. 한 섹션에만 두되 소유 > 그룹 > 공유 순으로 고른다
    const rank = (r: RepoDto) => (r.type === "srepo" ? 2 : r.type === "grepo" ? 1 : 0);
    const [repos, starred] = await Promise.all([
      this.api.get<RepoDto[]>("/api2/repos/"),
      // 즐겨찾기를 못 받아도 저장소 목록은 보여 준다
      this.api.get<{ starred_item_list: { repo_id: string; path: string }[] }>("/api/v2.1/starred-items/").then(
        (s) => new Set(s.starred_item_list.filter((i) => i.path === "/").map((i) => i.repo_id)),
        () => new Set<string>(),
      ),
    ]);
    const byId = new Map<string, RepoDto>();
    for (const r of repos) {
      const prev = byId.get(r.id);
      if (!prev || rank(r) < rank(prev)) byId.set(r.id, r);
    }
    return [...byId.values()].map((r) => ({
      id: r.id, name: r.name, size: r.size, mtime: r.mtime, encrypted: !!r.encrypted, headCommitId: r.head_commit_id,
      section: r.type === "grepo" || r.type === "srepo" ? "나에게 공유됨" : "내 저장소",
      starred: starred.has(r.id),
      // cloud-edit은 웹에서 문서 편집만 되고 업로드·이름 변경은 안 된다
      readOnly: ["r", "preview", "cloud-edit"].includes(r.permission ?? ""),
    }));
  }

  async starLibrary(libId: string, starred: boolean): Promise<void> {
    if (starred) await this.api.postForm("/api/v2.1/starred-items/", { repo_id: libId, path: "/" });
    else await this.api.delete("/api/v2.1/starred-items/", { repo_id: libId, path: "/" });
  }

  async renameLibrary(libId: string, newName: string): Promise<void> {
    await this.api.postForm(`/api2/repos/${libId}/`, { repo_name: newName }, { op: "rename" });
  }

  async listDir(libId: string, path: string): Promise<Entry[]> {
    const items = await this.api.get<DirentDto[]>(`/api2/repos/${libId}/dir/`, { p: path });
    return items
      .map((d) => ({ id: d.id, name: d.name, type: d.type, size: d.size ?? 0, mtime: d.mtime, path: joinPath(path, d.name) }))
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
  }

  async upload(libId: string, task: UploadTask, onProgress: (sent: number, total: number) => void, signal?: AbortSignal): Promise<void> {
    const { file, targetDir, relativePath } = task;
    const dir = relativePath ? joinPath(targetDir, relativePath) : targetDir;
    const size = file.size;
    const throwIfAborted = () => {
      if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    };
    throwIfAborted();

    // 이어올리기: 이 앱이 중단한 파일만. 서버 temp가 파일 전체 크기 이상이면 커밋 안 된 옛 temp로 보고 처음부터.
    let uploaded = 0;
    if (isInterrupted(file)) {
      uploaded = await this.api
        .get<{ uploadedBytes: number }>(`/api/v2.1/repos/${libId}/file-uploaded-bytes/`, { parent_dir: dir, file_name: file.name }, signal)
        .then((r) => r.uploadedBytes ?? 0)
        .catch((e) => {
          if ((e as Error).name === "AbortError") throw e;
          return 0;
        });
      if (uploaded >= size) uploaded = 0;
    }
    throwIfAborted();

    let link = await this.uploadLink(libId, targetDir, signal);
    const form = (blob: Blob) => {
      const f = new FormData();
      f.append("file", blob, file.name);
      f.append("parent_dir", targetDir);
      if (relativePath) f.append("relative_path", relativePath);
      f.append("replace", "1");
      return f;
    };
    const progress = (sent: number) => onProgress(Math.min(sent, size), size);

    const ranges = chunkRanges(size, uploaded, CHUNK_SIZE);
    if (ranges.length === 0) {
      await xhrUpload(link, form(await sliceOf(file, 0, size)), {}, progress, signal);
      onProgress(size, size);
      return;
    }
    markInterrupted(file);
    // XHR 헤더는 ISO-8859-1만 허용 → 파일명은 percent-encoding (Seahub resumable과 동일)
    const disposition = `attachment; filename="${encodeURIComponent(file.name)}"`;
    for (const { start, end } of ranges) {
      throwIfAborted();
      const headers = { "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Disposition": disposition };
      const blob = await sliceOf(file, start, end + 1);
      const send = () => xhrUpload(link, form(blob), headers, (sent) => progress(start + sent), signal);
      try {
        await send();
      } catch (e) {
        // 업로드 링크 만료(403/500) → 링크 한 번 다시 받아 같은 청크 재시도
        if (signal?.aborted || !isLinkExpired(e)) throw e;
        link = await this.uploadLink(libId, targetDir, signal);
        await send();
      }
      progress(end + 1);
    }
    clearInterrupted(file);
  }

  private async uploadLink(libId: string, dir: string, signal?: AbortSignal): Promise<string> {
    const url = await this.api.get<string>(`/api2/repos/${libId}/upload-link/`, { p: dir }, signal);
    return `${url}?ret-json=1`;
  }

  async downloadUrl(libId: string, path: string): Promise<string> {
    return this.api.get<string>(`/api2/repos/${libId}/file/`, { p: path, reuse: "1" });
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
    return this.api.getBlob(`/api2/repos/${libId}/thumbnail/`, { p: path, size: String(size) }, signal);
  }
  async mkdir(libId: string, path: string): Promise<void> {
    await this.api.postForm(`/api2/repos/${libId}/dir/`, { operation: "mkdir" }, { p: path });
  }
  async rename(libId: string, path: string, newName: string, type: "file" | "dir"): Promise<void> {
    await this.api.postForm(`/api2/repos/${libId}/${type}/`, { operation: "rename", newname: newName }, { p: path });
  }
  async remove(libId: string, path: string, type: "file" | "dir"): Promise<void> {
    await this.api.delete(`/api2/repos/${libId}/${type}/`, { p: path });
  }
  async move(libId: string, srcDir: string, names: string[], dstDir: string): Promise<void> {
    await this.api.postJson("/api/v2.1/repos/sync-batch-move-item/", { src_repo_id: libId, src_parent_dir: srcDir, src_dirents: names, dst_repo_id: libId, dst_parent_dir: dstDir });
  }
  async createShareLink(libId: string, path: string, opts?: { password?: string; expireDays?: number }): Promise<ShareLink> {
    const form: Record<string, string> = { repo_id: libId, path };
    if (opts?.password) form.password = opts.password;
    if (opts?.expireDays) form.expire_days = String(opts.expireDays);
    const res = await this.api.postForm<{ link: string; expire_date?: string }>("/api/v2.1/share-links/", form);
    const expiresAt = res.expire_date ? Date.parse(res.expire_date) / 1000 : undefined;
    return expiresAt && !Number.isNaN(expiresAt) ? { url: res.link, expiresAt } : { url: res.link };
  }

  async listTree(libId: string): Promise<Entry[]> {
    // v2.1 dir API의 recursive=1: 요청 한 번에 전체 트리. mtime은 ISO 문자열로 온다
    const r = await this.api.get<{ dirent_list: TreeDirentDto[] }>(`/api/v2.1/repos/${libId}/dir/`, { p: "/", recursive: "1" });
    return r.dirent_list.map((d) => ({
      id: d.id,
      name: d.name,
      type: d.type,
      size: d.size ?? 0,
      mtime: typeof d.mtime === "number" ? d.mtime : Math.floor(Date.parse(d.mtime) / 1000) || 0,
      path: joinPath(d.parent_dir, d.name),
    }));
  }

  async listShareLinks(): Promise<ShareLinkInfo[]> {
    const rows = await this.api.get<ShareLinkDto[]>("/api/v2.1/share-links/");
    const sec = (iso: string | null) => (iso ? Math.floor(Date.parse(iso) / 1000) || undefined : undefined);
    return rows.map((r) => ({
      token: r.token,
      url: r.link,
      libId: r.repo_id,
      libName: r.repo_name,
      path: r.path,
      name: r.obj_name,
      type: r.is_dir ? "dir" : "file",
      expiresAt: sec(r.expire_date),
      expired: !!r.is_expired,
      protected: !!r.is_encrypted || !!r.password, // 버전에 따라 is_encrypted 또는 password(소유자에게 보여 주는 값) 중 하나만 온다
      views: r.view_cnt ?? 0,
      createdAt: sec(r.ctime) ?? 0,
    }));
  }
  async deleteShareLink(token: string): Promise<void> {
    await this.api.delete(`/api/v2.1/share-links/${token}/`);
  }

  async listTrash(libId: string): Promise<TrashEntry[]> {
    const out: TrashEntry[] = [];
    let scanStat: string | undefined;
    // 서버가 커밋을 훑으며 100개씩 준다. shortcut: 최대 10페이지(약 1000개)까지만, 더 필요하면 "더 보기"로
    for (let i = 0; i < 10; i++) {
      const r = await this.api.get<{ data: TrashDto[]; more: boolean; scan_stat?: string }>(`/api/v2.1/repos/${libId}/trash/`, scanStat ? { path: "/", scan_stat: scanStat } : { path: "/" });
      for (const d of r.data) {
        const deletedAt = Date.parse(d.deleted_time) / 1000;
        out.push({ name: d.obj_name, type: d.is_dir ? "dir" : "file", size: d.size ?? 0, parentDir: d.parent_dir, deletedAt: Number.isNaN(deletedAt) ? 0 : deletedAt, commitId: d.commit_id });
      }
      if (!r.more || !r.scan_stat) break;
      scanStat = r.scan_stat;
    }
    return out;
  }
  async restoreTrash(libId: string, e: TrashEntry): Promise<void> {
    await this.api.postForm(`/api/v2.1/repos/${libId}/${e.type}/`, { operation: "revert", commit_id: e.commitId }, { p: joinPath(e.parentDir, e.name) });
  }
  async emptyTrash(libId: string): Promise<void> {
    await this.api.delete(`/api/v2.1/repos/${libId}/trash/`, { keep_days: "0" });
  }
}
