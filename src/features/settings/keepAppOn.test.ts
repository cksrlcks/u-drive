import { beforeEach, describe, expect, it, vi } from "vitest";

const autostart = vi.hoisted(() => ({ isEnabled: vi.fn(), enable: vi.fn() }));
const prefs = vi.hoisted(() => ({ closeToTray: true }));
const persistent = vi.hoisted(() => ({ on: true }));
const setPrefs = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/plugin-autostart", () => autostart);
vi.mock("@/features/settings/appPrefs", () => ({ getPrefs: () => prefs, setPrefs }));
vi.mock("@/storage/session", () => ({ isPersistent: () => persistent.on }));

import { enableKeepOn, needsKeepOn } from "./keepAppOn";

beforeEach(() => {
  vi.clearAllMocks();
  autostart.isEnabled.mockResolvedValue(true);
  autostart.enable.mockResolvedValue(undefined);
  prefs.closeToTray = true;
  persistent.on = true;
});

describe("needsKeepOn", () => {
  it("모두 켜져 있으면 필요 없다", async () => {
    expect(await needsKeepOn()).toEqual({ any: false, autoLoginOff: false });
  });
  it("자동 실행이 꺼져 있으면 필요하다", async () => {
    autostart.isEnabled.mockResolvedValue(false);
    expect((await needsKeepOn()).any).toBe(true);
  });
  it("자동 실행을 확인하지 못하면 켜져 있다고 본다", async () => {
    autostart.isEnabled.mockRejectedValue(new Error("x"));
    expect((await needsKeepOn()).any).toBe(false);
  });
  it("트레이가 꺼져 있으면 필요하다", async () => {
    prefs.closeToTray = false;
    expect((await needsKeepOn()).any).toBe(true);
  });
  it("자동 로그인이 꺼져 있으면 필요하고 알린다", async () => {
    persistent.on = false;
    expect(await needsKeepOn()).toEqual({ any: true, autoLoginOff: true });
  });
});

describe("enableKeepOn", () => {
  it("자동 실행·트레이·자동 로그인을 켠다", async () => {
    const makePersistent = vi.fn();
    expect(await enableKeepOn(makePersistent)).toBeNull();
    expect(autostart.enable).toHaveBeenCalled();
    expect(setPrefs).toHaveBeenCalledWith({ closeToTray: true });
    expect(makePersistent).toHaveBeenCalled();
  });
  it("자동 실행을 못 켜도 나머지는 켜고 문구를 돌려준다", async () => {
    autostart.enable.mockRejectedValue(new Error("거부"));
    const makePersistent = vi.fn();
    expect(await enableKeepOn(makePersistent)).toBe("자동 실행을 켜지 못했습니다 (거부)");
    expect(setPrefs).toHaveBeenCalledWith({ closeToTray: true });
    expect(makePersistent).toHaveBeenCalled();
  });
});
