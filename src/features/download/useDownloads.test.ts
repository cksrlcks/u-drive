import { describe, expect, it } from "vitest";
import { pickSaver } from "./useDownloads";

describe("pickSaver", () => {
  it("nas:// 주소는 nas", () => expect(pickSaver("nas://p1/a.psd")).toBe("nas"));
  it("그 외는 http", () => expect(pickSaver("https://x.test/a.psd")).toBe("http"));
});
