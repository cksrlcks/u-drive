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
export const registerRunner = (id: string, fn: (o?: RunOpts) => void) => {
  runners.set(id, fn);
  return () => void (runners.get(id) === fn && runners.delete(id));
};
/** 지금 동기화(우클릭 메뉴·다시 시작). 모르는 id·일시정지 연결은 무시 */
export const requestRun = (id: string, opts?: RunOpts) => runners.get(id)?.(opts);

/** 한 번에 하나만 돌린다. 도는 중 트리거는 끝난 뒤 한 번만 더 돈다(run은 throw하지 않아야 한다) */
export function createScheduler(run: (o: RunOpts) => Promise<void>) {
  let running = false;
  let again: RunOpts | null = null;
  const trigger = (o: RunOpts = {}) => {
    if (running) {
      again = { confirmedDeletes: !!(again?.confirmedDeletes || o.confirmedDeletes) };
      return;
    }
    running = true;
    void run(o).finally(() => {
      running = false;
      const next = again;
      again = null;
      if (next) trigger(next);
    });
  };
  return trigger;
}
