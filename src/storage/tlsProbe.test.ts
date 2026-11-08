import { afterEach, describe, expect, it, vi } from "vitest";
import { detectConnection } from "./detect";
import { StorageError } from "./StorageProvider";
import { probeTls, refineNetworkError } from "./tlsProbe";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

describe("refineNetworkError", () => {
  const net = () => new StorageError("network", "Failed to fetch");

  it("프로브가 certificate 라고 하면 certificate 오류로 바꾸고 ca.crt 주소를 넣는다", async () => {
    const out = (await refineNetworkError(net(), "https://drive.example:8443/", async () => "certificate")) as StorageError;
    expect(out).toBeInstanceOf(StorageError);
    expect(out.kind).toBe("certificate");
    expect(out.message).toBe("https://drive.example:8443/ca.crt");
  });
  it("프로브가 unreachable·ok·null(브라우저)이면 원래 오류 그대로", async () => {
    const e = net();
    expect(await refineNetworkError(e, "https://h", async () => "unreachable")).toBe(e);
    expect(await refineNetworkError(e, "https://h", async () => "ok")).toBe(e);
    expect(await refineNetworkError(e, "https://h", async () => null)).toBe(e);
  });
  it("network 가 아닌 오류는 프로브하지 않는다", async () => {
    const e = new StorageError("unauthorized", "", 401);
    let probed = false;
    expect(await refineNetworkError(e, "https://h", async () => { probed = true; return "certificate"; })).toBe(e);
    expect(probed).toBe(false);
  });
});

describe("probeTls (앱 안)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    invoke.mockReset();
  });
  const inApp = () => vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });

  it("tls_probe 에 host·port 를 넘기고 결과를 그대로 돌려준다", async () => {
    inApp();
    invoke.mockResolvedValue("certificate");
    expect(await probeTls("https://192.168.0.48:8443/")).toBe("certificate");
    expect(invoke).toHaveBeenCalledWith("tls_probe", { host: "192.168.0.48", port: 8443 });
  });
  it("invoke 가 거부되면(예: ACL 에 없는 명령) null → 원래 네트워크 오류가 남는다", async () => {
    inApp();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    invoke.mockRejectedValue("Command tls_probe not allowed by ACL");
    expect(await probeTls("https://h:8443")).toBeNull();
    const e = new StorageError("network", "Failed to fetch");
    expect(await refineNetworkError(e, "https://h:8443")).toBe(e);
  });
  it("브라우저·http 주소는 프로브하지 않는다", async () => {
    expect(await probeTls("https://h")).toBeNull();
    inApp();
    expect(await probeTls("http://h")).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("ping(detectConnection)부터 실패하는 경우", () => {
  it("판별 실패로 주소가 그대로 남아도 로그인 network 오류는 certificate 로 바뀐다", async () => {
    const conn = { kind: "seafile" as const, baseUrl: "https://drive.example:8443" };
    const detected = await detectConnection(conn, vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    const out = (await refineNetworkError(new StorageError("network", "Failed to fetch"), detected.baseUrl, async () => "certificate")) as StorageError;
    expect(out.kind).toBe("certificate");
    expect(out.message).toBe("https://drive.example:8443/ca.crt");
  });
});
