import { afterEach, describe, expect, it, vi } from "vitest";
import { SeafileProvider } from "./SeafileProvider";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

afterEach(() => fetchMock.mockReset());

describe("SeafileProvider", () => {
  it("login stores token", async () => {
    fetchMock.mockResolvedValue(json({ token: "t1" }));
    const p = new SeafileProvider("https://host.example", null);
    await p.login("me", "pw");
    expect(p.isLoggedIn()).toBe(true);
    expect(p.token).toBe("t1");
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toBe("https://host.example/api2/auth-token/");
  });

  it("login with device info asks for a per-device token", async () => {
    fetchMock.mockResolvedValue(json({ token: "t2" }));
    const p = new SeafileProvider("https://host.example", null);
    await p.login("me", "pw", undefined, { platform: "mac", deviceId: "d".repeat(32), deviceName: "내 맥북", clientVersion: "0.10.2" });
    const body = new URLSearchParams(String(fetchMock.mock.calls[0][1].body));
    expect(Object.fromEntries(body)).toEqual({ username: "me", password: "pw", platform: "mac", device_id: "d".repeat(32), device_name: "내 맥북", client_version: "0.10.2" });
    expect(p.token).toBe("t2");
  });

  it("logout revokes the token on the server and still logs out when that fails", async () => {
    fetchMock.mockResolvedValue(json({}));
    const p = new SeafileProvider("https://host.example", "t");
    await p.logout();
    expect(fetchMock.mock.calls[0][0]).toBe("https://host.example/api2/logout-device/");
    expect(fetchMock.mock.calls[0][1].method).toBe("POST");
    expect(new Headers(fetchMock.mock.calls[0][1].headers).get("Authorization")).toBe("Token t");
    expect(p.isLoggedIn()).toBe(false);

    fetchMock.mockRejectedValue(new TypeError("offline"));
    const q = new SeafileProvider("https://host.example", "t");
    await q.logout();
    expect(q.isLoggedIn()).toBe(false);
  });

  it("listDir maps and sorts entries", async () => {
    fetchMock.mockResolvedValue(
      json([
        { id: "1", name: "b.txt", type: "file", size: 1, mtime: 1 },
        { id: "2", name: "a", type: "dir", size: 0, mtime: 1 },
      ]),
    );
    const p = new SeafileProvider("https://host.example", "t");
    const entries = await p.listDir("r", "/x");
    expect(entries.map((e) => e.path)).toEqual(["/x/a", "/x/b.txt"]);
    expect(entries[0].type).toBe("dir");
  });

  it("listLibraries: owned → 내 저장소, group/shared → 나에게 공유됨, starred roots marked", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.includes("/starred-items/")
        ? json({ starred_item_list: [{ repo_id: "d", path: "/" }, { repo_id: "b", path: "/sub" }] })
        : json([
            { id: "a", name: "집-공유", type: "repo", size: 0, mtime: 1, encrypted: false },
            { id: "b", name: "내 라이브러리", type: "repo", size: 0, mtime: 1, encrypted: false },
            { id: "a", name: "집-공유", type: "grepo", group_name: "집", size: 0, mtime: 1, encrypted: false },
            { id: "c", name: "받은 것", type: "srepo", permission: "rw", size: 0, mtime: 1, encrypted: false },
            { id: "d", name: "팀 드라이브", type: "grepo", group_name: "디자인팀", permission: "r", size: 0, mtime: 1, encrypted: false },
          ]),
    );
    const libs = await new SeafileProvider("https://host.example", "t").listLibraries();
    expect(libs.map((l) => [l.id, l.section, l.starred, l.readOnly])).toEqual([
      ["a", "내 저장소", false, false],
      ["b", "내 저장소", false, false],
      ["c", "나에게 공유됨", false, false],
      ["d", "나에게 공유됨", true, true],
    ]);
  });

  it("listLibraries still lists libraries when starred items fail", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.includes("/starred-items/") ? json({ error_msg: "nope" }, 500) : json([{ id: "a", name: "a", type: "repo", size: 0, mtime: 1, encrypted: false }]),
    );
    const libs = await new SeafileProvider("https://host.example", "t").listLibraries();
    expect(libs.map((l) => l.id)).toEqual(["a"]);
  });
});

describe("SeafileProvider file operations", () => {
  it("rename dir uses dir endpoint", async () => {
    fetchMock.mockResolvedValue(json("success"));
    await new SeafileProvider("https://host.example", "t").rename("r", "/a/old", "new", "dir");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://host.example/api2/repos/r/dir/?p=%2Fa%2Fold");
    expect(init.method).toBe("POST");
    expect(String(init.body)).toBe("operation=rename&newname=new");
  });

  it("rename file uses file endpoint", async () => {
    fetchMock.mockResolvedValue(json("success"));
    await new SeafileProvider("https://host.example", "t").rename("r", "/a.txt", "b.txt", "file");
    expect(fetchMock.mock.calls[0][0]).toBe("https://host.example/api2/repos/r/file/?p=%2Fa.txt");
  });

  it("remove file uses DELETE", async () => {
    fetchMock.mockResolvedValue(json("success"));
    await new SeafileProvider("https://host.example", "t").remove("r", "/a.txt", "file");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://host.example/api2/repos/r/file/?p=%2Fa.txt");
    expect(init.method).toBe("DELETE");
  });

  it("mkdir posts operation=mkdir", async () => {
    fetchMock.mockResolvedValue(json("success"));
    await new SeafileProvider("https://host.example", "t").mkdir("r", "/new dir");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://host.example/api2/repos/r/dir/?p=%2Fnew+dir");
    expect(String(init.body)).toBe("operation=mkdir");
  });

  it("downloadUrl returns the temp link", async () => {
    fetchMock.mockResolvedValue(json("https://host.example/seafhttp/files/abc/a.txt"));
    const url = await new SeafileProvider("https://host.example", "t").downloadUrl("r", "/a.txt");
    expect(url).toBe("https://host.example/seafhttp/files/abc/a.txt");
    expect(fetchMock.mock.calls[0][0]).toBe("https://host.example/api2/repos/r/file/?p=%2Fa.txt&reuse=1");
  });
});

describe("SeafileProvider.renameLibrary", () => {
  it("posts op=rename with repo_name", async () => {
    fetchMock.mockResolvedValue(json("success"));
    await new SeafileProvider("https://host.example", "t").renameLibrary("r1", "새 이름");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://host.example/api2/repos/r1/?op=rename");
    expect(init.method).toBe("POST");
    expect(String(init.body)).toBe("repo_name=%EC%83%88+%EC%9D%B4%EB%A6%84");
  });
});

describe("SeafileProvider.getAccount", () => {
  it("maps usage and quota", async () => {
    fetchMock.mockResolvedValue(json({ email: "me@x.com", name: "Me", usage: 1234, total: 53687091200 }));
    const acc = await new SeafileProvider("https://host.example", "t").getAccount();
    expect(fetchMock.mock.calls[0][0]).toBe("https://host.example/api2/account/info/");
    expect(acc).toEqual({ email: "me@x.com", name: "Me", usage: 1234, quota: 53687091200 });
  });

  it("maps unlimited quota (-2) to null", async () => {
    fetchMock.mockResolvedValue(json({ email: "me@x.com", name: "", usage: 0, total: -2 }));
    const acc = await new SeafileProvider("https://host.example", "t").getAccount();
    expect(acc.quota).toBeNull();
    expect(acc.name).toBe("me@x.com");
  });
});

describe("SeafileProvider trash", () => {
  it("listTrash maps entries and follows scan_stat pages", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ data: [{ obj_name: "a.txt", parent_dir: "/d", is_dir: false, size: 3, deleted_time: "2026-10-26T00:00:00+00:00", commit_id: "c1" }], more: true, scan_stat: "s1" }))
      .mockResolvedValueOnce(json({ data: [{ obj_name: "sub", parent_dir: "/", is_dir: true, deleted_time: "2026-10-26T00:00:00+00:00", commit_id: "c2" }], more: false }));
    const items = await new SeafileProvider("https://host.example", "t").listTrash("r");
    expect(items).toEqual([
      { name: "a.txt", type: "file", size: 3, parentDir: "/d", deletedAt: 1792972800, commitId: "c1" },
      { name: "sub", type: "dir", size: 0, parentDir: "/", deletedAt: 1792972800, commitId: "c2" },
    ]);
    expect(fetchMock.mock.calls[1][0]).toContain("scan_stat=s1");
  });

  it("restoreTrash reverts a dir at its old path with the commit id", async () => {
    fetchMock.mockResolvedValue(json("success"));
    await new SeafileProvider("https://host.example", "t").restoreTrash("r", { name: "sub", type: "dir", size: 0, parentDir: "/d", deletedAt: 0, commitId: "c2" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://host.example/api/v2.1/repos/r/dir/?p=%2Fd%2Fsub");
    expect(String(init.body)).toBe("operation=revert&commit_id=c2");
  });
});

describe("SeafileProvider listTree", () => {
  it("flattens the recursive listing into absolute paths", async () => {
    fetchMock.mockResolvedValue(
      json({
        dirent_list: [
          { type: "dir", id: "d1", name: "a", parent_dir: "/", mtime: "2026-10-26T00:00:00+00:00" },
          { type: "file", id: "f1", name: "b.txt", parent_dir: "/a", size: 5, mtime: "2026-10-26T00:00:00+00:00" },
        ],
      }),
    );
    const tree = await new SeafileProvider("https://host.example", "t").listTree("r");
    expect(fetchMock.mock.calls[0][0]).toBe("https://host.example/api/v2.1/repos/r/dir/?p=%2F&recursive=1");
    expect(tree).toEqual([
      { id: "d1", name: "a", type: "dir", size: 0, mtime: 1792972800, path: "/a" },
      { id: "f1", name: "b.txt", type: "file", size: 5, mtime: 1792972800, path: "/a/b.txt" },
    ]);
  });
});

describe("SeafileProvider.move", () => {
  it("move posts a JSON batch move within the same library", async () => {
    fetchMock.mockResolvedValue(json({ success: true }));
    await new SeafileProvider("https://host.example", "t").move("r", "/a", ["x.txt", "y"], "/a/b");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://host.example/api/v2.1/repos/sync-batch-move-item/");
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({ src_repo_id: "r", src_parent_dir: "/a", src_dirents: ["x.txt", "y"], dst_repo_id: "r", dst_parent_dir: "/a/b" });
  });
});
