import { describe, expect, it } from "vitest";
import { toLocalTasks } from "./localUpload";

describe("toLocalTasks", () => {
  it("keeps sub folders as relativePath and converts mtime to ms", () => {
    const tasks = toLocalTasks(
      [
        { path: "/home/a/사진/2026/b.jpg", name: "b.jpg", dir: "사진/2026", size: 3, mtime: 1.5 },
        { path: "/home/a/메모.txt", name: "메모.txt", dir: "", size: 1, mtime: 2 },
      ],
      "/docs",
    );
    expect(tasks).toEqual([
      { file: { name: "b.jpg", size: 3, lastModified: 1500, localPath: "/home/a/사진/2026/b.jpg" }, targetDir: "/docs", relativePath: "사진/2026" },
      { file: { name: "메모.txt", size: 1, lastModified: 2000, localPath: "/home/a/메모.txt" }, targetDir: "/docs" },
    ]);
  });
});
