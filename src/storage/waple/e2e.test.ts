/**
 * 실서버 연동. 환경 변수가 없으면 건너뛴다.
 *   WAPLE_E2E_URL=http://127.0.0.1:18080 WAPLE_E2E_EMAIL=admin@test WAPLE_E2E_PW=pw WAPLE_E2E_REPO=<repo id> npx vitest run e2e
 * node 환경이라 XHR 이 없다: 업로드는 fetch 로 PUT 하는 어댑터를 끼운다(xhrRequest 모킹).
 */
import { afterAll, describe, expect, it, vi } from "vitest";

const URL_ = process.env.WAPLE_E2E_URL;
const EMAIL = process.env.WAPLE_E2E_EMAIL ?? "admin@test";
const PW = process.env.WAPLE_E2E_PW ?? "pw";
const REPO = process.env.WAPLE_E2E_REPO ?? "";

vi.mock("../xhrUpload", () => ({
  xhrRequest: async (method: string, url: string, body: Blob | FormData, headers: Record<string, string>, onProgress: (n: number) => void) => {
    const res = await fetch(url, { method, headers, body });
    const text = await res.text();
    if (!res.ok) {
      const { StorageError } = await import("../StorageProvider");
      throw new StorageError(res.status === 401 ? "unauthorized" : "server", text, res.status);
    }
    onProgress((body as Blob).size ?? 0);
    return text;
  },
  xhrUpload: vi.fn(),
}));

import { WapleProvider } from "./WapleProvider";

const run = URL_ && REPO ? describe : describe.skip;

run("WapleProvider against a live server", () => {
  const p = new WapleProvider(URL_!, null);
  const stamp = Date.now().toString(36);
  const dir = `/e2e-${stamp}`;
  const big = new Uint8Array(20 * 1024 * 1024 + 123).map((_, i) => (i * 31) % 251);

  afterAll(async () => {
    if (p.isLoggedIn()) await p.remove(REPO, dir, "dir").catch(() => undefined);
    await p.logout();
  });

  it("logs in with a device token", async () => {
    await p.login(EMAIL, PW, undefined, { platform: "windows", deviceId: "e".repeat(40), deviceName: "e2e", clientVersion: "0.0.0" });
    expect(p.isLoggedIn()).toBe(true);
    const acc = await p.getAccount();
    expect(acc.email.toLowerCase()).toBe(EMAIL.toLowerCase());
  });

  it("lists libraries including the target repo", async () => {
    const libs = await p.listLibraries();
    const r = libs.find((l) => l.id === REPO);
    expect(r).toBeDefined();
    expect(r!.headCommitId).toHaveLength(64);
  });

  it("mkdir, small upload, listDir, download roundtrip", async () => {
    await p.mkdir(REPO, dir);
    const file = new File([new TextEncoder().encode("hello e2e")], "hello.txt", { lastModified: 1_700_000_000_000 });
    const seen: number[] = [];
    await p.upload(REPO, { file, targetDir: dir }, (s) => seen.push(s));
    expect(seen[seen.length - 1]).toBe(file.size);
    const items = await p.listDir(REPO, dir);
    expect(items.map((e) => e.name)).toEqual(["hello.txt"]);
    expect(items[0].mtime).toBe(1_700_000_000);
    expect(await p.readText(REPO, `${dir}/hello.txt`)).toBe("hello e2e");
  });

  it("large chunked upload roundtrips byte-for-byte", async () => {
    const file = new File([big], "big.bin", { lastModified: Date.now() });
    await p.upload(REPO, { file, targetDir: dir, relativePath: "deep/er" }, () => {});
    const url = await p.downloadUrl(REPO, `${dir}/deep/er/big.bin`);
    const got = new Uint8Array(await (await fetch(url)).arrayBuffer());
    expect(got.length).toBe(big.length);
    expect(got.every((b, i) => b === big[i])).toBe(true);
    const tree = await p.listTree(REPO);
    expect(tree.some((e) => e.path === `${dir}/deep/er/big.bin`)).toBe(true);
  });

  it("rename, move, remove, trash restore", async () => {
    await p.rename(REPO, `${dir}/hello.txt`, "renamed.txt", "file");
    await p.mkdir(REPO, `${dir}/dst`);
    await p.move(REPO, dir, ["renamed.txt"], `${dir}/dst`);
    expect((await p.listDir(REPO, `${dir}/dst`)).map((e) => e.name)).toEqual(["renamed.txt"]);
    await p.remove(REPO, `${dir}/dst/renamed.txt`, "file");
    const trash = await p.listTrash(REPO);
    const entry = trash.find((t) => t.name === "renamed.txt" && t.parentDir === `${dir}/dst`);
    expect(entry).toBeDefined();
    await p.restoreTrash(REPO, entry!);
    expect((await p.listDir(REPO, `${dir}/dst`)).map((e) => e.name)).toEqual(["renamed.txt"]);
  });

  it("share link create/list/delete and thumbnail 415 for text", async () => {
    const link = await p.createShareLink(REPO, `${dir}/dst/renamed.txt`, { expireDays: 1 });
    expect(link.url).toContain("/s/");
    const mine = await p.listShareLinks();
    const found = mine.find((l) => l.url === link.url);
    expect(found?.type).toBe("file");
    await p.deleteShareLink(found!.token);
    expect((await p.listShareLinks()).some((l) => l.token === found!.token)).toBe(false);
    await expect(p.thumbnail(REPO, `${dir}/dst/renamed.txt`, 64)).rejects.toMatchObject({ status: 415 });
  });
});
