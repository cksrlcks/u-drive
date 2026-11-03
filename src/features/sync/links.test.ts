import { describe, expect, it } from "vitest";
import { addLink, findLink, followMove, followMoveAll, getLinks, linkUnder, movesLinkIntoLink, removeLink } from "@/features/sync/links";
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
  it("followMoveAll updates stored links", () => {
    addLink(L({ id: "x", drivePath: "/a/기획안" }));
    followMoveAll("lib", "/a", "/b");
    expect(getLinks("a").find((l) => l.id === "x")?.drivePath).toBe("/b/기획안");
    removeLink("x");
  });
  it("followMoveAll leaves other libraries alone", () => {
    addLink(L({ id: "y", libId: "other", drivePath: "/a/기획안" }));
    followMoveAll("lib", "/a", "/b");
    expect(getLinks("a").find((l) => l.id === "y")?.drivePath).toBe("/a/기획안");
    removeLink("y");
  });
  it("linkUnder finds a link root or its ancestors", () => {
    const ls = [L({ drivePath: "/a/기획안" })];
    expect(linkUnder(ls, "lib", "/a")?.id).toBe("1");
    expect(linkUnder(ls, "lib", "/")?.id).toBe("1");
    expect(linkUnder(ls, "lib", "/a/기획안")?.id).toBe("1");
    expect(linkUnder(ls, "lib", "/a/기")).toBeUndefined();
  });
  it("movesLinkIntoLink refuses nesting only", () => {
    const ls = [L({ id: "1", drivePath: "/a" }), L({ id: "2", drivePath: "/b" })];
    expect(movesLinkIntoLink(ls, "lib", ["/a"], "/b/x")).toBe(true);
    expect(movesLinkIntoLink(ls, "lib", ["/a"], "/c")).toBe(false);
    expect(movesLinkIntoLink(ls, "lib", ["/c"], "/b")).toBe(false);
  });
});
