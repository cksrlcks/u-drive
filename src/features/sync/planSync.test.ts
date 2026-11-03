import { describe, expect, it } from "vitest";

import { emptyBaseline, planSync } from "./planSync";
import type { Baseline, Scan, ScanFile } from "./type";

const f = (rel: string, size = 1, mtime = 100): ScanFile => ({ rel, path: `C:/p/${rel}`, size, mtime });
const scan = (files: ScanFile[], dirs: string[] = []): Scan => ({ files, dirs, totalBytes: 0, unreadable: [] });
const base = (files: ScanFile[], dirs: string[] = []): Baseline => ({ files: Object.fromEntries(files.map((x) => [x.rel, { size: x.size, mtime: x.mtime }])), dirs });
const opts = { nowSec: 1000, fresh: false };

describe("planSync", () => {
  it("uploads new and changed files only", () => {
    const p = planSync(scan([f("a"), f("b", 2), f("c")]), base([f("a"), f("b", 1)]), opts);
    expect(p.uploads.map((x) => x.rel)).toEqual(["b", "c"]);
  });
  it("defers files modified within SETTLE_SEC", () => {
    const p = planSync(scan([f("a", 1, 999)]), emptyBaseline(), opts);
    expect(p.uploads).toEqual([]);
    expect(p.deferred).toBe(1);
  });
  it("uploads files with a future mtime (clock ahead) instead of deferring forever", () => {
    const p = planSync(scan([f("a", 1, 1000 + 3600), f("b", 1, 999)]), emptyBaseline(), opts);
    expect(p.uploads.map((x) => x.rel)).toEqual(["a"]);
    expect(p.deferred).toBe(1);
  });
  it("removes baseline files missing locally", () => {
    expect(planSync(scan([f("a")]), base([f("a"), f("b")]), opts).removeFiles).toEqual(["b"]);
  });
  it("orders mkdirs shallow-first and removeDirs deep-first", () => {
    const p = planSync(scan([], ["x", "x/y"]), base([], ["z", "z/w"]), opts);
    expect(p.mkdirs).toEqual(["x", "x/y"]);
    expect(p.removeDirs).toEqual(["z/w", "z"]);
  });
  it("fresh link never removes", () => {
    const p = planSync(scan([]), base([f("a")], ["d"]), { ...opts, fresh: true });
    expect(p.removeFiles).toEqual([]);
    expect(p.removeDirs).toEqual([]);
  });
  const ten = Array.from({ length: 10 }, (_, i) => f(`f${i}`));
  it("all files gone triggers mass delete", () => {
    expect(planSync(scan([]), base(ten), opts).massDelete).toBe(true);
  });
  it("small deletions do not trigger mass delete", () => {
    expect(planSync(scan(ten.slice(0, 1)), base(ten.slice(0, 2)), opts).massDelete).toBe(false); // 1개
    expect(planSync(scan(ten.slice(0, 1)), base(ten), opts).massDelete).toBe(false); // 9개: 90%지만 10개 미만
  });
  it("over 500 deletions trigger even at low ratio", () => {
    const many = Array.from({ length: 2000 }, (_, i) => f(`f${i}`));
    expect(planSync(scan(many.slice(0, 1499)), base(many), opts).massDelete).toBe(true); // 501개
  });
  it("confirmedDeletes bypasses mass delete", () => {
    expect(planSync(scan([]), base(ten), { ...opts, confirmedDeletes: true }).massDelete).toBe(false);
  });
  it("never removes anything at or under an unreadable path (segment-aware)", () => {
    const b = base([f("locked/a.docx"), f("locked/x/b"), f("lockedX/c"), f("gone")], ["locked", "locked/x", "lockedX"]);
    const p = planSync({ ...scan([]), unreadable: ["locked"] }, b, opts);
    expect(p.removeFiles.sort()).toEqual(["gone", "lockedX/c"]);
    expect(p.removeDirs).toEqual(["lockedX"]);
  });
  it("empty unreadable path protects everything", () => {
    const p = planSync({ ...scan([]), unreadable: [""] }, base(ten), opts);
    expect(p.removeFiles).toEqual([]);
    expect(p.massDelete).toBe(false);
  });
});
