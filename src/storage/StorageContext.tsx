import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { isTauri } from "@/features/shell/platform";
import { createProvider } from "./createProvider";
import { deviceInfo } from "./device";
import { clearToken, loadSession, saveSession, type Session } from "./session";
import { nasClient } from "./nas/native";
import { withNas } from "./nas/withNas";
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
  const provider = useMemo(() => {
    const p = createProvider(session.connection, session.token);
    return isTauri() ? withNas(p, nasClient) : p;
  }, [session]);

  const login = useCallback(async (conn: Connection, username: string, password: string, otp?: string, opts?: { persistent?: boolean }) => {
    const p = createProvider(conn, null);
    await p.login(username, password, otp, await deviceInfo());
    const next: Session = { connection: conn, token: p.token };
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
