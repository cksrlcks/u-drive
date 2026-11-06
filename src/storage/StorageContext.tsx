import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { createProvider } from "./createProvider";
import { detectConnection } from "./detect";
import { refineNetworkError } from "./tlsProbe";
import { deviceInfo } from "./device";
import { clearToken, loadSession, saveSession, type Session } from "./session";
import type { Connection, StorageProvider } from "./StorageProvider";

interface SessionApi {
  session: Session;
  login(conn: Connection, username: string, password: string, otp?: string, opts?: { persistent?: boolean }): Promise<void>;
  logout(): void;
  /** 지금 로그인을 자동 로그인으로 바꾼다(토큰을 localStorage에 둔다) */
  makePersistent(): void;
  onUnauthorized(): void;
}

const ProviderCtx = createContext<StorageProvider | null>(null);
const SessionCtx = createContext<SessionApi | null>(null);

export function StorageRoot({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session>(() => loadSession());
  const provider = useMemo(() => createProvider(session.connection, session.token), [session]);

  const login = useCallback(async (conn: Connection, username: string, password: string, otp?: string, opts?: { persistent?: boolean }) => {
    // 서버 종류는 사용자가 고르지 않는다: ping 헤더로 판별(판별 실패 = 기존 서버 종류)
    const detected = await detectConnection(conn);
    const p = createProvider(detected, null);
    try {
      await p.login(username, password, otp, await deviceInfo());
    } catch (e) {
      // 인증서 오류는 "연결 실패" 와 다르게 안내해야 하므로 Rust 로 한 번 확인한다
      throw await refineNetworkError(e, detected.baseUrl);
    }
    const next: Session = { connection: detected, token: p.token };
    saveSession(next, opts);
    setSession(next);
  }, []);

  // 토큰이 이미 무효(401)면 로컬에서만 지운다
  const expire = useCallback(() => {
    clearToken();
    setSession(loadSession());
  }, []);

  // 사용자가 로그아웃: 서버의 토큰도 지운다(기다리지 않는다)
  const logout = useCallback(() => {
    void provider.logout();
    expire();
  }, [provider, expire]);

  const makePersistent = useCallback(() => saveSession(session, { persistent: true }), [session]);

  const api = useMemo<SessionApi>(() => ({ session, login, logout, makePersistent, onUnauthorized: expire }), [session, login, logout, makePersistent, expire]);

  return (
    <SessionCtx.Provider value={api}>
      <ProviderCtx.Provider value={provider}>{children}</ProviderCtx.Provider>
    </SessionCtx.Provider>
  );
}

export function useStorage(): StorageProvider {
  const p = useContext(ProviderCtx);
  if (!p) throw new Error("useStorage outside StorageRoot");
  return p;
}

export function useSession(): SessionApi {
  const s = useContext(SessionCtx);
  if (!s) throw new Error("useSession outside StorageRoot");
  return s;
}
