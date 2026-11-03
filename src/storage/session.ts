import type { Connection } from "./StorageProvider";

export interface Session {
  connection: Connection;
  token: string | null;
}
export interface LoginPrefs {
  /** "아이디 저장"이 켜져 있으면 마지막 아이디 */
  username: string | null;
  /** 자동 로그인: 토큰을 앱을 닫아도 유지(localStorage) / 끄면 이번 실행 동안만(sessionStorage) */
  autoLogin: boolean;
}
interface Stores {
  local: Storage;
  session: Storage;
}

const KEY = "seadrive.session";
const PREFS_KEY = "seadrive.loginPrefs";
const DEFAULT: Session = { connection: { kind: "seafile", baseUrl: "https://uxis.heavybear-lab.net" }, token: null };
/** 같은 서버가 https 주소로 옮겨 갔다. 저장된 예전 주소는 새 주소로 읽는다(토큰은 같은 서버라 그대로 쓴다) */
const MOVED: Record<string, string> = { "http://192.168.1.240": DEFAULT.connection.baseUrl };
const defaultStores = (): Stores => ({ local: localStorage, session: sessionStorage });

/** http 서버 주소: 비밀번호·토큰이 평문으로 나가므로 받지 않는다 */
export class InsecureServerError extends Error {
  constructor() {
    super("서버 주소는 https://로 시작해야 합니다");
  }
}

/** https, 개발용 mock, 이 PC 안의 개발 서버(http://localhost·127.0.0.1)만 허용 */
export function isSecureServer(baseUrl: string): boolean {
  return baseUrl === "mock" || /^https:\/\//i.test(baseUrl) || /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(baseUrl);
}

/** 입력한 서버 주소로 Connection을 만든다. "mock"은 개발용 인메모리 백엔드. 주소만 쓰면 https로, http 주소면 InsecureServerError */
export function connectionFor(url: string): Connection {
  const trimmed = url.trim().replace(/\/+$/, "");
  const baseUrl = trimmed === "mock" || /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  if (!isSecureServer(baseUrl)) throw new InsecureServerError();
  return { kind: baseUrl === "mock" ? "mock" : "seafile", baseUrl };
}

function parse(raw: string | null): Partial<Session> | null {
  try {
    return raw ? (JSON.parse(raw) as Partial<Session>) : null;
  } catch {
    return null;
  }
}

/** 연결 정보는 항상 localStorage. 토큰은 자동 로그인이면 localStorage, 아니면 sessionStorage에서 읽는다. */
export function loadSession(stores: Stores = defaultStores()): Session {
  const local = parse(stores.local.getItem(KEY));
  const sess = parse(stores.session.getItem(KEY));
  const connection = local?.connection?.baseUrl ? local.connection : sess?.connection?.baseUrl ? sess.connection : DEFAULT.connection;
  const moved = MOVED[connection.baseUrl.toLowerCase()];
  if (moved) return { connection: { ...connection, baseUrl: moved }, token: local?.token ?? sess?.token ?? null };
  // 예전에 저장한 http 주소: 그 주소로는 요청하지 않는다(기본 주소로 다시 로그인)
  if (!isSecureServer(connection.baseUrl)) return DEFAULT;
  return { connection, token: local?.token ?? sess?.token ?? null };
}

export function saveSession(s: Session, opts: { persistent?: boolean } = {}, stores: Stores = defaultStores()): void {
  const persistent = opts.persistent ?? true;
  stores.local.setItem(KEY, JSON.stringify({ connection: s.connection, token: persistent ? s.token : null }));
  if (persistent) stores.session.removeItem(KEY);
  else stores.session.setItem(KEY, JSON.stringify(s));
}

/** 토큰이 localStorage에 있나(자동 로그인) */
export function isPersistent(stores: Stores = defaultStores()): boolean {
  return !!parse(stores.local.getItem(KEY))?.token;
}

export function clearToken(stores: Stores = defaultStores()): void {
  const cur = loadSession(stores);
  stores.local.setItem(KEY, JSON.stringify({ connection: cur.connection, token: null }));
  stores.session.removeItem(KEY);
}

export function loadPrefs(local: Storage = localStorage): LoginPrefs {
  try {
    const p = JSON.parse(local.getItem(PREFS_KEY) ?? "{}") as Partial<LoginPrefs>;
    return { username: p.username ?? null, autoLogin: p.autoLogin ?? true };
  } catch {
    return { username: null, autoLogin: true };
  }
}

export function savePrefs(p: LoginPrefs, local: Storage = localStorage): void {
  local.setItem(PREFS_KEY, JSON.stringify(p));
}
