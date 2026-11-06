import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../xhrUpload", () => ({ xhrRequest: vi.fn(), xhrUpload: vi.fn() }));
vi.mock("../chunk", async (orig) => ({ ...(await orig<typeof import("../chunk")>()), CHUNK_SIZE: 8 }));

import { StorageError } from "../StorageProvider";
import { xhrRequest } from "../xhrUpload";
import { WapleProvider } from "./WapleProvider";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);
const xhr = vi.mocked(xhrRequest);

/** 세션 생성 응답과 PUT 응답을 흉내낸다 */
function server(received: number, opts: { conflictAt?: number; conflictReceived?: number } = {}) {
  fetchMock.mockImplementation(async (url: string) => {
    if (url.endsWith("/upload-sessions")) return new Response(JSON.stringify({ session_id: "s1", received_bytes: received }), { status: 201 });
    return new Response(JSON.stringify({ message: "?" }), { status: 404 });
  });
  let n = 0;
  xhr.mockImplementation(async (_method, _url, body, headers) => {
    n++;
    if (opts.conflictAt === n) throw new StorageError("server", JSON.stringify({ message: "이어 올리기 위치가 다릅니다", received_bytes: opts.conflictReceived }), 409);
    const range = (headers as Record<string, string>)["Content-Range"];
    const end = range ? Number(range.match(/-(\d+)\//)![1]) + 1 : (body as Blob).size;
    return JSON.stringify({ received_bytes: end, done: true, fs_id: "f", commit_id: "c" });
  });
}

function fileOf(bytes: number, name = "big.bin"): File {
  return new File([new Uint8Array(bytes)], name, { lastModified: 1_700_000_000_123 });
}

const p = () => new WapleProvider("https://host.example", "t");
const callsOf = () => xhr.mock.calls.map((c) => ({ method: c[0], url: c[1], size: (c[2] as Blob).size, range: (c[3] as Record<string, string>)["Content-Range"] }));

beforeEach(() => {
  xhr.mockReset(); // 반환값이 있으면 vitest 가 teardown 으로 부른다
});
afterEach(() => fetchMock.mockReset());

describe("WapleProvider.upload", () => {
  it("opens a session with snake_case fields and mtime in seconds, then one PUT without Content-Range for a small file", async () => {
    server(0);
    const sent: number[] = [];
    await p().upload("r", { file: fileOf(5, "a.txt"), targetDir: "/docs", relativePath: "x/y" }, (s) => sent.push(s));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://host.example/api/v1/repos/r/upload-sessions");
    expect(JSON.parse(String(init.body))).toEqual({ parent_dir: "/docs", relative_path: "x/y", file_name: "a.txt", size: 5, replace: true, mtime: 1_700_000_000 });
    expect(callsOf()).toEqual([{ method: "PUT", url: "https://host.example/api/v1/upload-sessions/s1", size: 5, range: undefined }]);
    expect(new Headers(xhr.mock.calls[0][3] as Record<string, string>).get("Authorization")).toBe("Token t");
    expect(sent[sent.length - 1]).toBe(5);
  });

  it("sends Content-Range chunks for a large file and resumes from received_bytes", async () => {
    server(8);
    const sent: number[] = [];
    await p().upload("r", { file: fileOf(20), targetDir: "/" }, (s) => sent.push(s));
    expect(callsOf().map((c) => c.range)).toEqual(["bytes 8-15/20", "bytes 16-19/20"]);
    expect(callsOf().map((c) => c.size)).toEqual([8, 4]);
    expect(sent[sent.length - 1]).toBe(20);
  });

  it("a session that already has every byte is finalized with one empty PUT", async () => {
    server(20);
    await p().upload("r", { file: fileOf(20), targetDir: "/" }, () => {});
    expect(callsOf()).toEqual([{ method: "PUT", url: "https://host.example/api/v1/upload-sessions/s1", size: 0, range: "bytes 0-19/20" }]);
  });

  it("on 409 it re-syncs once from the server's received_bytes", async () => {
    server(0, { conflictAt: 1, conflictReceived: 8 });
    await p().upload("r", { file: fileOf(20), targetDir: "/" }, () => {});
    expect(callsOf().map((c) => c.range)).toEqual(["bytes 0-7/20", "bytes 8-15/20", "bytes 16-19/20"]);
  });

  it("a second 409 is a real error", async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ session_id: "s1", received_bytes: 0 }), { status: 201 }));
    xhr.mockRejectedValue(new StorageError("server", JSON.stringify({ message: "이어 올리기 위치가 다릅니다", received_bytes: 8 }), 409));
    await expect(p().upload("r", { file: fileOf(20), targetDir: "/" }, () => {})).rejects.toMatchObject({ status: 409 });
  });

  it("aborts before opening a session when the signal is already aborted", async () => {
    server(0);
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(p().upload("r", { file: fileOf(5), targetDir: "/" }, () => {}, ctrl.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
