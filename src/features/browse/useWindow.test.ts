import { describe, expect, it } from "vitest";
import { visibleRange } from "./useWindow";

describe("visibleRange", () => {
  it("맨 위: 첫 줄부터 화면+overscan까지", () => {
    expect(visibleRange(0, 340, 20000, 28, 34, 2)).toEqual({ start: 0, end: 12 });
  });
  it("중간: 위아래 overscan", () => {
    // 줄 100이 화면 맨 위(28 + 100*34 = 3428)
    expect(visibleRange(3428, 340, 20000, 28, 34, 2)).toEqual({ start: 98, end: 112 });
  });
  it("끝: count를 넘지 않는다", () => {
    expect(visibleRange(1e9, 340, 50, 28, 34, 2)).toEqual({ start: 50, end: 50 });
  });
  it("빈 목록", () => {
    expect(visibleRange(0, 340, 0, 28, 34, 2)).toEqual({ start: 0, end: 0 });
  });
});
