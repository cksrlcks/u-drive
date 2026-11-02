import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./xhrUpload", () => ({ xhrUpload: vi.fn(async () => "ok") }));
const invokeMock = vi.fn(async (_cmd: string, a: { start: number; len: number }) => new Uint8Array(a.len).fill(a.start).buffer);
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("./chunk", async (orig) => ({ ...(await orig<typeof import("./chunk")>()), CHUNK_SIZE: 8 }));

import { SeafileProvider } from "./SeafileProvider";
import { markInterrupted, clearInterrupted } from "./resumeRegistry";
import { xhrUpload } from "./xhrUpload";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);
const xhr = vi.mocked(xhrUpload);

function server(uploadedBytes: number) {
  fetchMock.mockImplementation(async (url: string) => {
    if (url.includes("file-uploaded-bytes")) return new Response(JSON.stringify({ uploadedBytes }), { status: 200 });
    if (url.includes("upload-link")) return new Response(JSON.stringify("https://host.example/seafhttp/upload-api/tok"), { status: 200 });
    return new Response("", { status: 404 });
  });
}

function fileOf(bytes: number, name = "big.bin"): File {
  return new File([new Uint8Array(bytes)], name, { lastModified: 1_700_000_000_000 });
}

const p = () => new SeafileProvider("https://host.example", "t");
const headersOf = (call: number) => xhr.mock.calls[call][2] as Record<string, string>;

beforeEach(() => xhr.mockClear());
afterEach(() => fetchMock.mockReset());

describe("SeafileProvider.upload", () => {
  it("reads a disk-path file chunk by chunk from the app", async () => {
    server(0);
    const file = { name: "big.bin", size: 20, lastModified: 1, localPath: "/home/a/big.bin" };
    await p().upload("r", { file, targetDir: "/d", relativePath: "사진" }, () => {});
    expect(invokeMock.mock.calls.map((c) => c[1])).toEqual([
      { path: "/home/a/big.bin", start: 0, len: 8 },
      { path: "/home/a/big.bin", start: 8, len: 8 },
      { path: "/home/a/big.bin", start: 16, len: 4 },
    ]);
    const blob = (xhr.mock.calls[2][1] as FormData).get("file") as File;
    expect([blob.name, blob.size]).toEqual(["big.bin", 4]);
    expect(headersOf(2)["Content-Range"]).toBe("bytes 16-19/20");
  });

  it("single post for small file", async () => {
    server(0);
    await p().upload("r", { file: fileOf(5), targetDir: "/d" }, () => {});
    expect(xhr).toHaveBeenCalledTimes(1);
    expect(xhr.mock.calls[0][0]).toBe("https://host.example/seafhttp/upload-api/tok?ret-json=1");
    expect(headersOf(0)["Content-Range"]).toBeUndefined();
    const form = xhr.mock.calls[0][1] as FormData;
    expect(form.get("parent_dir")).toBe("/d");
    expect(form.get("replace")).toBe("1");
  });

  it("resumes from uploadedBytes when the file was interrupted before", async () => {
    server(8);
    const f = fileOf(20);
    markInterrupted(f);
    await p().upload("r", { file: f, targetDir: "/d" }, () => {});
    expect(xhr).toHaveBeenCalledTimes(2);
    expect(headersOf(0)["Content-Range"]).toBe("bytes 8-15/20");
    expect(headersOf(1)["Content-Range"]).toBe("bytes 16-19/20");
    expect(headersOf(0)["Content-Disposition"]).toBe('attachment; filename="big.bin"');
  });

  it("starts from zero when the file was never interrupted, even if server has bytes", async () => {
    server(8);
    const f = fileOf(20);
    clearInterrupted(f);
    await p().upload("r", { file: f, targetDir: "/d" }, () => {});
    expect(xhr).toHaveBeenCalledTimes(3);
    expect(headersOf(0)["Content-Range"]).toBe("bytes 0-7/20");
    expect(fetchMock.mock.calls.some((c) => (c[0] as string).includes("file-uploaded-bytes"))).toBe(false);
  });

  it("restarts from zero when server reports the full size (stale temp)", async () => {
    server(20);
    const f = fileOf(20);
    markInterrupted(f);
    await p().upload("r", { file: f, targetDir: "/d" }, () => {});
    expect(xhr).toHaveBeenCalledTimes(3);
    expect(headersOf(0)["Content-Range"]).toBe("bytes 0-7/20");
  });

  it("clears the interrupted mark after success and sets it while chunking", async () => {
    server(0);
    const f = fileOf(20);
    await p().upload("r", { file: f, targetDir: "/d" }, () => {});
    const { isInterrupted } = await import("./resumeRegistry");
    expect(isInterrupted(f)).toBe(false);
  });

  it("encodes non-latin filename in Content-Disposition", async () => {
    server(0);
    await p().upload("r", { file: fileOf(20, "회의 녹화.mp4"), targetDir: "/d" }, () => {});
    expect(headersOf(0)["Content-Disposition"]).toBe('attachment; filename="%ED%9A%8C%EC%9D%98%20%EB%85%B9%ED%99%94.mp4"');
  });

  it("does not start when the signal is already aborted", async () => {
    server(0);
    const ctrl = new AbortController();
    ctrl.abort();
    const err = await p().upload("r", { file: fileOf(5), targetDir: "/d" }, () => {}, ctrl.signal).catch((e) => e);
    expect((err as Error).name).toBe("AbortError");
    expect(xhr).not.toHaveBeenCalled();
  });

  it("asks uploaded bytes under the relative dir", async () => {
    server(0);
    const f = fileOf(5);
    markInterrupted(f);
    await p().upload("r", { file: f, targetDir: "/d", relativePath: "a/b" }, () => {});
    const askUrl = fetchMock.mock.calls.find((c) => (c[0] as string).includes("file-uploaded-bytes"))![0] as string;
    expect(askUrl).toContain("parent_dir=%2Fd%2Fa%2Fb");
    expect((xhr.mock.calls[0][1] as FormData).get("relative_path")).toBe("a/b");
  });
});
