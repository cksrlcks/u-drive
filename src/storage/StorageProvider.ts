import type { DeviceInfo } from "./device";

export interface Library {
  id: string;
  name: string;
  size: number;
  mtime: number;
  encrypted: boolean;
  /** 사이드바 섹션 이름: "내 저장소" 또는 "나에게 공유됨"(개인·그룹 공유 모두) */
  section: string;
  /** 즐겨찾기. 사이드바 맨 위 "즐겨찾기" 섹션에 둔다 */
  starred?: boolean;
  /** 읽기 전용으로 공유받은 저장소. 업로드·새 폴더·이름 변경·삭제를 끈다 */
  readOnly?: boolean;
  /** 내용이 바뀔 때마다 달라지는 서버 식별자. 검색 인덱스 갱신 판단용 */
  headCommitId?: string;
}

export interface Entry {
  id: string;
  name: string;
  type: "file" | "dir";
  size: number;
  mtime: number;
  /** 부모 경로 + 이름, '/'로 시작 */
  path: string;
}

/** PC 디스크의 파일(데스크톱 앱의 폴더 업로드·Linux 끌어다 놓기). 내용은 올릴 때 조각씩 읽는다 */
export interface PathFile {
  name: string;
  size: number;
  lastModified: number;
  localPath: string;
}

export interface UploadTask {
  file: File | PathFile;
  targetDir: string;
  /** 폴더 드롭 시 targetDir 아래 하위 경로 ('a/b') */
  relativePath?: string;
}

export interface Account {
  name: string;
  email: string;
  /** 사용 중인 바이트 */
  usage: number;
  /** 할당량 바이트. 무제한이면 null */
  quota: number | null;
}

export interface ShareLink {
  url: string;
  expiresAt?: number;
}

/** 내가 만든 공유 링크 */
export interface ShareLinkInfo {
  /** 삭제에 쓰는 서버 식별자 */
  token: string;
  url: string;
  libId: string;
  libName: string;
  path: string;
  name: string;
  type: "file" | "dir";
  expiresAt?: number;
  expired: boolean;
  /** 비밀번호가 걸려 있음 */
  protected: boolean;
  views: number;
  createdAt: number;
}

/** 휴지통 항목. 복구하면 parentDir로 돌아간다 */
export interface TrashEntry {
  name: string;
  type: "file" | "dir";
  size: number;
  parentDir: string;
  deletedAt: number;
  /** 복구에 필요한 서버 식별자 (Seafile: 삭제 커밋 id) */
  commitId: string;
}

/** certificate: TLS 인증서를 신뢰할 수 없음(network 의 세분화. message = CA 인증서 주소). 로그인 화면만 구분해 보여 준다 */
export type StorageErrorKind = "unauthorized" | "notFound" | "network" | "server" | "certificate";

export class StorageError extends Error {
  constructor(
    public kind: StorageErrorKind,
    message: string,
    public status?: number,
  ) {
    super(message);
    this.name = "StorageError";
  }
}

export interface Connection {
  /** "mock"은 개발·화면 확인용 (서버 없음). "waple"은 Waple Drive 서버(ping 헤더로 자동 판별) */
  kind: "seafile" | "waple" | "mock";
  baseUrl: string;
}

export interface StorageProvider {
  /** 현재 인증 토큰. 세션 저장용. 로그인 전/로그아웃 후 null */
  readonly token: string | null;
  login(username: string, password: string, otp?: string, device?: DeviceInfo | null): Promise<void>;
  /** 서버의 토큰도 지운다(가능하면) */
  logout(): Promise<void>;
  isLoggedIn(): boolean;

  getAccount(): Promise<Account>;
  /** 내가 속한 그룹 이름 */
  listGroups(): Promise<string[]>;
  listLibraries(): Promise<Library[]>;
  renameLibrary(libId: string, newName: string): Promise<void>;
  starLibrary(libId: string, starred: boolean): Promise<void>;
  listDir(libId: string, path: string): Promise<Entry[]>;
  /** 저장소 전체의 파일·폴더를 한 번에(검색 인덱스용) */
  listTree(libId: string): Promise<Entry[]>;

  upload(
    libId: string,
    task: UploadTask,
    onProgress: (sent: number, total: number) => void,
    signal?: AbortSignal,
  ): Promise<void>;
  /** 만료 있는 임시 URL */
  downloadUrl(libId: string, path: string): Promise<string>;
  previewUrl(libId: string, path: string): Promise<string>;
  readText(libId: string, path: string): Promise<string>;
  /** 서버가 만든 이미지 썸네일. 썸네일을 못 만드는 파일이면 reject */
  thumbnail(libId: string, path: string, size: number, signal?: AbortSignal): Promise<Blob>;

  mkdir(libId: string, path: string): Promise<void>;
  rename(libId: string, path: string, newName: string, type: "file" | "dir"): Promise<void>;
  remove(libId: string, path: string, type: "file" | "dir"): Promise<void>;
  /** 같은 저장소 안에서 srcDir의 names를 dstDir로 옮긴다. 같은 이름 확인은 호출하는 쪽 몫 */
  move(libId: string, srcDir: string, names: string[], dstDir: string): Promise<void>;

  createShareLink(
    libId: string,
    path: string,
    opts?: { password?: string; expireDays?: number },
  ): Promise<ShareLink>;

  listShareLinks(): Promise<ShareLinkInfo[]>;
  deleteShareLink(token: string): Promise<void>;

  listTrash(libId: string): Promise<TrashEntry[]>;
  restoreTrash(libId: string, entry: TrashEntry): Promise<void>;
  /** 항목별 영구 삭제는 Seafile이 지원하지 않아 저장소 휴지통 전체를 비운다 */
  emptyTrash(libId: string): Promise<void>;
}
