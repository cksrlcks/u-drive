import { describe, expect, it } from "vitest";
import { createScheduler } from "./syncState";

const tick = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe("createScheduler", () => {
  it("도는 중 트리거는 한 번으로 합쳐 끝난 뒤 다시 돈다", async () => {
    const gates: (() => void)[] = [];
    const seen: (boolean | undefined)[] = [];
    const trigger = createScheduler((o) => {
      seen.push(o.confirmedDeletes);
      return new Promise<void>((r) => gates.push(r));
    });
    trigger();
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
    expect(seen).toHaveLength(3);
  });
});
