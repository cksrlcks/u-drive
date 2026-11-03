import { useSyncExternalStore } from "react";
import type { LinkState } from "./type";

type RunOpts = { confirmedDeletes?: boolean };

const IDLE: LinkState = { status: "idle", pending: 0, lastSyncedAt: null };
let states: Record<string, LinkState> = {};
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

export function setLinkState(id: string, patch: Partial<LinkState>) {
  states = { ...states, [id]: { ...(states[id] ?? IDLE), ...patch } };
  listeners.forEach((l) => l());
}

export const useLinkState = (id: string): LinkState => useSyncExternalStore(subscribe, () => states[id] ?? IDLE);
export const useAllLinkStates = (): Record<string, LinkState> => useSyncExternalStore(subscribe, () => states);

const runners = new Map<string, (o?: RunOpts) => void>();
/** [취소]한 연결: 사용자가 다시 시작할 때까지 자동 실행(감시·타이머·마운트)을 막는다 */
const held = new Set<string>();
export const holdLink = (id: string) => void held.add(id);
export const isHeld = (id: string) => held.has(id);

/** 자동 트리거는 보류 중이면 건너뛰고, 수동(requestRun)은 보류를 풀고 돈다. 수동 쪽만 requestRun에 등록한다 */
export function linkTriggers(id: string, trigger: (o?: RunOpts) => void) {
  const auto = (o?: RunOpts) => {
    if (!held.has(id)) trigger(o);
  };
  const manual = (o?: RunOpts) => {
    held.delete(id);
    trigger(o);
  };
  runners.set(id, manual);
  return { auto, off: () => void (runners.get(id) === manual && runners.delete(id)) };
}
/** 지금 동기화(우클릭 메뉴·다시 시작). 모르는 id·일시정지 연결은 무시 */
export const requestRun = (id: string, opts?: RunOpts) => runners.get(id)?.(opts);

/** 연결 id별로 한 번에 하나만 돌린다(엔진이 다시 만들어져도 앞 실행이 끝난 뒤 시작). 도는 중 트리거는 끝난 뒤 한 번만 더 돈다(run은 throw하지 않아야 한다) */
const inflight = new Map<string, Promise<void>>();
export function createScheduler(key: string, run: (o: RunOpts) => Promise<void>) {
  let running = false;
  let again: RunOpts | null = null;
  const trigger = (o: RunOpts = {}) => {
    if (running) {
      again = { confirmedDeletes: !!(again?.confirmedDeletes || o.confirmedDeletes) };
      return;
    }
    running = true;
    const prev = inflight.get(key);
    const p: Promise<void> = (prev ? prev.then(() => run(o)) : run(o)).finally(() => {
      if (inflight.get(key) === p) inflight.delete(key);
      running = false;
      const next = again;
      again = null;
      if (next) trigger(next);
    });
    inflight.set(key, p);
  };
  return trigger;
}
