import type { Connection } from "./StorageProvider";

/**
 * 서버 종류 자동 판별. Waple Drive 는 `GET /api/v1/ping` 에 `X-Waple-Drive: <버전>` 헤더를 준다.
 * 헤더가 없거나(Seafile 은 404) 요청이 실패하면 seafile 로 둔다 — 판별 실패가 로그인 흐름을 막지 않게.
 */
export async function detectConnection(conn: Connection, fetchFn: typeof fetch = fetch): Promise<Connection> {
  if (conn.kind === "mock") return conn;
  let res: Response;
  try {
    res = await fetchFn(`${conn.baseUrl.replace(/\/+$/, "")}/api/v1/ping`, { method: "GET" });
  } catch {
    return conn; // 연결 실패는 로그인 단계에서 다시 드러난다. 저장된 종류는 건드리지 않는다
  }
  return { kind: res.headers.get("X-Waple-Drive") ? "waple" : "seafile", baseUrl: conn.baseUrl };
}
