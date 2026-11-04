import { describe, expect, it } from "vitest";
import { pickSaver, plainName } from "./useDownloads";

describe("plainName", () => {
  it("평범한 이름은 그대로", () => expect(plainName("보고서.psd")).toBe("보고서.psd"));
  it("폴더 부분을 뗀다", () => {
    expect(plainName("../x")).toBe("x");
    expect(plainName("a\\b")).toBe("b");
    expect(plainName("C:evil.dll")).toBe("evil.dll");
    expect(plainName("..\\..\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\x.bat")).toBe("x.bat");
  });
  it("비거나 ./..이면 file", () => {
    for (const n of ["", ".", "..", "a/", "a/.."]) expect(plainName(n)).toBe("file");
  });
});

describe("pickSaver", () => {
  it("nas:// 주소는 nas", () => expect(pickSaver("nas://p1/a.psd")).toBe("nas"));
  it("그 외는 http", () => expect(pickSaver("https://x.test/a.psd")).toBe("http"));
});
