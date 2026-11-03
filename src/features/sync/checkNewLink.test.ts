import { describe, expect, it } from "vitest";
import { checkNewLink, isWholeDrive } from "@/features/sync/checkNewLink";
import type { SyncLink } from "@/features/sync/type";

const L = (p: Partial<SyncLink>): SyncLink => ({ id: "1", account: "a", libId: "lib", drivePath: "/기획안", localRoot: "D:\\기획안", paused: false, fresh: false, ...p });
const ok = {
  links: [] as SyncLink[], libId: "lib", dir: "/", localRoot: "E:\\새", name: "새",
  lib: { readOnly: false, encrypted: false },
  existing: undefined as { type: "file" | "dir" } | undefined,
  totalBytes: 10, quotaLeft: 100 as number | null,
};
const fail = (reason: string) => ({ ok: false, reason });

describe("checkNewLink", () => {
  it("rejects read-only", () => expect(checkNewLink({ ...ok, lib: { readOnly: true, encrypted: false } })).toEqual(fail("읽기 전용 저장소에는 동기화 폴더를 만들 수 없습니다")));
  it("rejects encrypted", () => expect(checkNewLink({ ...ok, lib: { encrypted: true } })).toEqual(fail("암호화된 저장소에는 동기화 폴더를 만들 수 없습니다")));
  it("rejects inside a linked folder", () => expect(checkNewLink({ ...ok, links: [L({})], dir: "/기획안/하위" })).toEqual(fail("이미 동기화 중인 폴더 안에는 만들 수 없습니다")));
  it("rejects overlapping local folders case-insensitively on Windows", () => {
    const r = checkNewLink({ ...ok, links: [L({ localRoot: "D:\\기획안" })], localRoot: "d:/기획안/하위" });
    expect(r).toEqual(fail("이미 동기화 중인 PC 폴더와 겹칩니다"));
  });
  it("rejects when the new folder contains an existing local root", () => expect(checkNewLink({ ...ok, links: [L({ localRoot: "D:\\기획안\\a" })], localRoot: "D:\\기획안" })).toEqual(fail("이미 동기화 중인 PC 폴더와 겹칩니다")));
  it("does not treat a sibling prefix as overlap", () => expect(checkNewLink({ ...ok, links: [L({ localRoot: "D:\\기획" })], localRoot: "D:\\기획안" })).toEqual({ ok: true, existing: false }));
  it("rejects a same-named file", () => expect(checkNewLink({ ...ok, existing: { type: "file" } })).toEqual(fail("같은 이름의 파일이 있습니다")));
  it("rejects insufficient quota", () => expect(checkNewLink({ ...ok, totalBytes: 101 })).toEqual(fail("드라이브 남은 용량이 부족합니다")));
  it("passes with no existing item", () => expect(checkNewLink(ok)).toEqual({ ok: true, existing: false }));
  it("passes onto an existing dir; unlimited quota", () => expect(checkNewLink({ ...ok, existing: { type: "dir" }, quotaLeft: null })).toEqual({ ok: true, existing: true }));
});

describe("isWholeDrive", () => {
  it("drive roots and UNC share roots are whole drives", () => {
    for (const p of ["C:\\", "C:", "d:/", "\\\\nas\\share", "\\\\nas\\share\\", "/"]) expect(isWholeDrive(p), p).toBe(true);
  });
  it("folders are not", () => {
    for (const p of ["C:\\문서", "\\\\nas\\share\\기획", "/Users/a"]) expect(isWholeDrive(p), p).toBe(false);
  });
});
