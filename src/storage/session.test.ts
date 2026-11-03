import { describe, expect, it } from "vitest";
import { clearToken, connectionFor, InsecureServerError, isPersistent, loadSession, saveSession } from "./session";

function memStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
    key: () => null,
    get length() {
      return m.size;
    },
  };
}

describe("session", () => {
  it("loadSession returns default when empty", () => {
    expect(loadSession({ local: memStorage(), session: memStorage() })).toEqual({
      connection: { kind: "seafile", baseUrl: "https://uxis.heavybear-lab.net" },
      token: null,
    });
  });

  it("moves the old http address to the new https address and keeps the token", () => {
    const s = { local: memStorage(), session: memStorage() };
    saveSession({ connection: { kind: "seafile", baseUrl: "http://192.168.1.240" }, token: "t" }, {}, s);
    expect(loadSession(s)).toEqual({ connection: { kind: "seafile", baseUrl: "https://uxis.heavybear-lab.net" }, token: "t" });
  });

  it("ignores a saved http address other than the moved one", () => {
    const s = { local: memStorage(), session: memStorage() };
    saveSession({ connection: { kind: "seafile", baseUrl: "http://10.0.0.5" }, token: "t" }, {}, s);
    expect(loadSession(s)).toEqual({ connection: { kind: "seafile", baseUrl: "https://uxis.heavybear-lab.net" }, token: null });
  });

  it("connectionFor accepts https, mock and local dev servers only", () => {
    expect(connectionFor(" https://drive.example/ ")).toEqual({ kind: "seafile", baseUrl: "https://drive.example" });
    expect(connectionFor("mock")).toEqual({ kind: "mock", baseUrl: "mock" });
    expect(connectionFor("http://localhost:8000").baseUrl).toBe("http://localhost:8000");
    expect(connectionFor("http://127.0.0.1").baseUrl).toBe("http://127.0.0.1");
    expect(() => connectionFor("http://uxis.heavybear-lab.net")).toThrow(InsecureServerError);
    expect(() => connectionFor("http://localhost.evil.com")).toThrow(InsecureServerError);
    expect(connectionFor("uxis.heavybear-lab.net").baseUrl).toBe("https://uxis.heavybear-lab.net");
    expect(() => connectionFor("ftp://x")).toThrow(InsecureServerError);
  });

  it("saveSession then loadSession round-trips", () => {
    const s = { local: memStorage(), session: memStorage() };
    saveSession({ connection: { kind: "seafile", baseUrl: "https://x" }, token: "t" }, {}, s);
    expect(loadSession(s)).toEqual({ connection: { kind: "seafile", baseUrl: "https://x" }, token: "t" });
  });

  it("clearToken keeps connection", () => {
    const s = { local: memStorage(), session: memStorage() };
    saveSession({ connection: { kind: "seafile", baseUrl: "https://x" }, token: "t" }, {}, s);
    clearToken(s);
    expect(loadSession(s)).toEqual({ connection: { kind: "seafile", baseUrl: "https://x" }, token: null });
  });
});

describe("session persistence modes", () => {
  it("keeps the token only for the session when autoLogin is off", () => {
    const local = memStorage();
    const session = memStorage();
    saveSession({ connection: { kind: "seafile", baseUrl: "https://x" }, token: "t" }, { persistent: false }, { local, session });
    expect(loadSession({ local, session }).token).toBe("t");
    expect(local.getItem("seadrive.session")).not.toContain('"t"');
    // 앱을 다시 열면(sessionStorage 비어 있음) 토큰이 없다
    expect(loadSession({ local, session: memStorage() }).token).toBeNull();
  });

  it("remembers the username independently of the token", async () => {
    const { loadPrefs, savePrefs } = await import("./session");
    const local = memStorage();
    savePrefs({ username: "me@x.com", autoLogin: false }, local);
    expect(loadPrefs(local)).toEqual({ username: "me@x.com", autoLogin: false });
    expect(loadPrefs(memStorage())).toEqual({ username: null, autoLogin: true });
  });

  it("isPersistent reflects where the token is stored", () => {
    const stores = { local: memStorage(), session: memStorage() };
    const s = { connection: { kind: "seafile" as const, baseUrl: "https://x.example" }, token: "t" };
    saveSession(s, { persistent: false }, stores);
    expect(isPersistent(stores)).toBe(false);
    saveSession(s, { persistent: true }, stores);
    expect(isPersistent(stores)).toBe(true);
  });
});
