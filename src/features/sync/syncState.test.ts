import { describe, expect, it } from "vitest";
import { createScheduler, holdLink, isHeld, linkTriggers, releaseHold, requestRun } from "./syncState";

const tick = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe("createScheduler", () => {
  it("도는 중 트리거는 한 번으로 합쳐 끝난 뒤 다시 돈다", async () => {
    const gates: (() => void)[] = [];
    const seen: (boolean | undefined)[] = [];
    const trigger = createScheduler("a", (o) => {
      seen.push(o.confirmedDeletes);
      return new Promise<void>((r) => gates.push(r));
    });
    trigger();
    await tick();
    trigger();
    trigger({ confirmedDeletes: true });
    expect(seen).toEqual([undefined]);
    gates[0]();
    await tick();
    expect(seen).toEqual([undefined, true]);
    gates[1]();
    await tick();
    expect(gates).toHaveLength(2);
    trigger();
    await tick();
    expect(seen).toHaveLength(3);
  });

  it("같은 id의 스케줄러 둘은 동시에 돌지 않는다", async () => {
    let active = 0;
    let max = 0;
    const gates: (() => void)[] = [];
    const run = async () => {
      max = Math.max(max, ++active);
      await new Promise<void>((r) => gates.push(r));
      active--;
    };
    const t1 = createScheduler("same", run);
    const t2 = createScheduler("same", run);
    t1();
    t2();
    await tick();
    expect(gates).toHaveLength(1);
    gates[0]();
    await tick();
    expect(gates).toHaveLength(2);
    gates[1]();
    await tick();
    expect(max).toBe(1);
  });
});

describe("보류", () => {
  it("보류 중엔 자동 트리거를 건너뛰고 requestRun이 풀고 돈다", () => {
    const calls: (boolean | undefined)[] = [];
    const { auto, off } = linkTriggers("h", (o) => void calls.push(o?.confirmedDeletes));
    holdLink("h");
    auto();
    expect(calls).toEqual([]);
    requestRun("h");
    expect(calls).toEqual([undefined]);
    auto();
    expect(calls).toHaveLength(2);
    holdLink("h");
    requestRun("h", { confirmedDeletes: true });
    expect(calls[2]).toBe(true);
    off();
    requestRun("h");
    expect(calls).toHaveLength(3);
  });
});

describe("releaseHold", () => {
  it("보류를 풀어 자동 트리거가 다시 돈다", () => {
    const calls: number[] = [];
    const { auto, off } = linkTriggers("r", () => void calls.push(1));
    holdLink("r");
    expect(isHeld("r")).toBe(true);
    releaseHold("r");
    expect(isHeld("r")).toBe(false);
    auto();
    expect(calls).toHaveLength(1);
    off();
  });
});
