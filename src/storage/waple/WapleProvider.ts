import { StorageError, type Account, type Entry, type Library, type ShareLink, type ShareLinkInfo, type StorageProvider, type TrashEntry, type UploadTask } from "../StorageProvider";
import type { DeviceInfo } from "../device";

const notImplemented = () => new StorageError("server", "아직 구현되지 않았습니다");

/** Waple Drive 서버용 StorageProvider. 로그인·로그아웃만 있고 나머지는 다음 작업(Task 3)에서 채운다. */
export class WapleProvider implements StorageProvider {
  private _token: string | null;

  constructor(
    readonly baseUrl: string,
    initialToken: string | null,
  ) {
    this._token = initialToken;
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
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/v1/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    } catch (e) {
      throw new StorageError("network", (e as Error).message);
    }
    if (!res.ok) throw new StorageError(res.status === 401 ? "unauthorized" : "server", await res.text(), res.status);
    this._token = ((await res.json()) as { token: string }).token;
  }

  async logout(): Promise<void> {
    this._token = null;
  }

  getAccount(): Promise<Account> { throw notImplemented(); }
  listGroups(): Promise<string[]> { throw notImplemented(); }
  listLibraries(): Promise<Library[]> { throw notImplemented(); }
  renameLibrary(): Promise<void> { throw notImplemented(); }
  starLibrary(): Promise<void> { throw notImplemented(); }
  listDir(): Promise<Entry[]> { throw notImplemented(); }
  listTree(): Promise<Entry[]> { throw notImplemented(); }
  upload(_libId: string, _task: UploadTask): Promise<void> { throw notImplemented(); }
  downloadUrl(): Promise<string> { throw notImplemented(); }
  previewUrl(): Promise<string> { throw notImplemented(); }
  readText(): Promise<string> { throw notImplemented(); }
  thumbnail(): Promise<Blob> { throw notImplemented(); }
  mkdir(): Promise<void> { throw notImplemented(); }
  rename(): Promise<void> { throw notImplemented(); }
  remove(): Promise<void> { throw notImplemented(); }
  move(): Promise<void> { throw notImplemented(); }
  createShareLink(): Promise<ShareLink> { throw notImplemented(); }
  listShareLinks(): Promise<ShareLinkInfo[]> { throw notImplemented(); }
  deleteShareLink(): Promise<void> { throw notImplemented(); }
  listTrash(): Promise<TrashEntry[]> { throw notImplemented(); }
  restoreTrash(): Promise<void> { throw notImplemented(); }
  emptyTrash(): Promise<void> { throw notImplemented(); }
}
