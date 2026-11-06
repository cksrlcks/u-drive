import { StorageError } from "../StorageProvider";

type Query = Record<string, string>;

/** Waple Drive API 호출. JSON 요청·응답, `Authorization: Token`, 오류 본문 `{ message }`. */
export class WapleApi {
  constructor(
    readonly baseUrl: string,
    private getToken: () => string | null,
  ) {}

  url(path: string, query?: Query): string {
    const u = this.baseUrl.replace(/\/+$/, "") + path;
    return query ? `${u}?${new URLSearchParams(query)}` : u;
  }

  headers(extra?: Query): Record<string, string> {
    const h: Record<string, string> = { Accept: "application/json", ...extra };
    const token = this.getToken();
    if (token) h.Authorization = `Token ${token}`;
    return h;
  }

  get<T>(path: string, query?: Query, signal?: AbortSignal): Promise<T> {
    return this.json<T>("GET", path, query, undefined, signal);
  }

  /** 이미지 등 JSON 이 아닌 응답 */
  async getBlob(path: string, query?: Query, signal?: AbortSignal): Promise<Blob> {
    return (await this.send("GET", path, query, undefined, signal)).blob();
  }

  postJson<T>(path: string, body?: unknown, query?: Query, signal?: AbortSignal): Promise<T> {
    return this.json<T>("POST", path, query, body, signal);
  }

  patchJson<T>(path: string, body: unknown): Promise<T> {
    return this.json<T>("PATCH", path, undefined, body);
  }

  async put(path: string): Promise<void> {
    await this.send("PUT", path);
  }

  async delete(path: string, query?: Query): Promise<void> {
    await this.send("DELETE", path, query);
  }

  private async json<T>(method: string, path: string, query?: Query, body?: unknown, signal?: AbortSignal): Promise<T> {
    const res = await this.send(method, path, query, body, signal);
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  private async send(method: string, path: string, query?: Query, body?: unknown, signal?: AbortSignal): Promise<Response> {
    const headers = this.headers(body !== undefined ? { "Content-Type": "application/json" } : undefined);
    let res: Response;
    try {
      res = await fetch(this.url(path, query), { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal });
    } catch (e) {
      if ((e as Error).name === "AbortError") throw e;
      throw new StorageError("network", (e as Error).message);
    }
    if (!res.ok) throw await toError(res);
    return res;
  }
}

/** 오류 응답 → StorageError. 서버 문구(`message`)는 한국어라 그대로 보여 줄 수 있다 */
export async function toError(res: Response): Promise<StorageError> {
  const text = await res.text().catch(() => "");
  const kind = res.status === 401 ? "unauthorized" : res.status === 404 ? "notFound" : "server";
  return new StorageError(kind, messageOf(text) || res.statusText, res.status);
}

export function messageOf(text: string): string {
  try {
    const j = JSON.parse(text) as { message?: string };
    return j.message || text;
  } catch {
    return text;
  }
}
