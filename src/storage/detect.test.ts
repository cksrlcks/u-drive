import { describe, expect, it, vi } from "vitest";
import { detectConnection } from "./detect";
import type { Connection } from "./StorageProvider";

const seafile: Connection = { kind: "seafile", baseUrl: "https://host.example" };

describe("detectConnection", () => {
  it("X-Waple-Drive 헤더가 있으면 waple", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response("{}", { status: 200, headers: { "X-Waple-Drive": "0.1.0" } }));
    expect(await detectConnection(seafile, fetchFn)).toEqual({ kind: "waple", baseUrl: "https://host.example" });
    expect(fetchFn.mock.calls[0][0]).toBe("https://host.example/api/v1/ping");
  });
  it("헤더가 없거나 404 거나 던지면 seafile 그대로 (로그인 흐름을 막지 않는다)", async () => {
    expect(await detectConnection(seafile, vi.fn(async () => new Response("{}", { status: 200 })))).toEqual(seafile);
    expect(await detectConnection(seafile, vi.fn(async () => new Response("", { status: 404 })))).toEqual(seafile);
    expect(await detectConnection(seafile, vi.fn(async () => { throw new TypeError("Failed to fetch"); }))).toEqual(seafile);
  });
  it("mock 은 건드리지 않는다", async () => {
    const fetchFn = vi.fn();
    const mock: Connection = { kind: "mock", baseUrl: "mock" };
    expect(await detectConnection(mock, fetchFn)).toEqual(mock);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
