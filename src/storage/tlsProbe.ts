import { isTauri } from "@/features/shell/platform";
import { StorageError } from "./StorageProvider";

export type TlsProbe = "ok" | "certificate" | "unreachable";

/**
 * WebView 의 fetch 는 인증서 오류와 연결 실패를 구분하지 못한다(둘 다 "Failed to fetch").
 * 앱 안에서는 Rust 로 TLS 핸드셰이크를 한 번 해 보고 OS 신뢰 저장소 기준으로 인증서 문제인지 가른다.
 * 브라우저(개발 화면)면 null.
 */
export async function probeTls(baseUrl: string): Promise<TlsProbe | null> {
  if (!isTauri()) return null;
  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  const { invoke } = await import("@tauri-apps/api/core");
  const port = u.port ? Number(u.port) : 443;
  return invoke<TlsProbe>("tls_probe", { host: u.hostname, port }).catch(() => null);
}

/** 앱이 안내할 CA 인증서 주소 */
export function caUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/ca.crt`;
}

/**
 * network 오류를 받으면 프로브로 인증서 문제인지 확인해 certificate 오류로 바꾼다(message = ca.crt 주소).
 * 그 밖의 오류는 그대로 돌려준다.
 */
export async function refineNetworkError(e: unknown, baseUrl: string, probe: (url: string) => Promise<TlsProbe | null> = probeTls): Promise<unknown> {
  if (!(e instanceof StorageError) || e.kind !== "network") return e;
  if ((await probe(baseUrl)) !== "certificate") return e;
  return new StorageError("certificate", caUrl(baseUrl));
}
