import { describe, expect, it } from "vitest";
import { findLink, followMove } from "@/features/sync/links";
import type { SyncLink } from "@/features/sync/type";

const L = (p: Partial<SyncLink>): SyncLink => ({ id: "1", account: "a", libId: "lib", drivePath: "/기획안", localRoot: "D:\\기획안", paused: false, fresh: false, ...p });

describe("links", () => {
  it("findLink matches root and descendants only", () => {
    expect(findLink([L({})], "lib", "/기획안")?.id).toBe("1");
    expect(findLink([L({})], "lib", "/기획안/하위")?.id).toBe("1");
    expect(findLink([L({})], "lib", "/기획안2")).toBeUndefined();
    expect(findLink([L({})], "other", "/기획안")).toBeUndefined();
  });
  it("followMove rewrites the link and links under a moved ancestor", () => {
    expect(followMove([L({ drivePath: "/a/기획안" })], "lib", "/a", "/b/a")[0].drivePath).toBe("/b/a/기획안");
    expect(followMove([L({})], "lib", "/기획안", "/새이름")[0].drivePath).toBe("/새이름");
    expect(followMove([L({})], "lib", "/기획", "/x")[0].drivePath).toBe("/기획안");
  });
});
