import { describe, expect, it } from "vitest";
import { CHUNK_SIZE, chunkRanges } from "./chunk";

describe("chunkRanges", () => {
  it("default chunk is 8MB", () => expect(CHUNK_SIZE).toBe(8 * 1024 * 1024));
  it("small file from start → single post", () => expect(chunkRanges(5, 0, 8)).toEqual([]));
  it("zero-byte file → single post", () => expect(chunkRanges(0, 0, 8)).toEqual([]));
  it("already complete → nothing", () => expect(chunkRanges(20, 20, 8)).toEqual([]));
  it("splits inclusive ranges", () =>
    expect(chunkRanges(20, 0, 8)).toEqual([
      { start: 0, end: 7 },
      { start: 8, end: 15 },
      { start: 16, end: 19 },
    ]));
  it("resumes from offset", () =>
    expect(chunkRanges(20, 8, 8)).toEqual([
      { start: 8, end: 15 },
      { start: 16, end: 19 },
    ]));
});
