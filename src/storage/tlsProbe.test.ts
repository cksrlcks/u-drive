import { describe, expect, it } from "vitest";
import { StorageError } from "./StorageProvider";
import { refineNetworkError } from "./tlsProbe";

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
