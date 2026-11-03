interface Source<T> {
  subscribe(fn: (items: T[]) => void): () => void;
  getSnapshot(): T[];
}

/**
 * 큐(업로드·다운로드)의 ids 항목이 모두 끝날 때까지 기다린다. ids 순서대로 마지막 상태를 돌려준다.
 * 끝나기 전에 목록에서 사라진 항목(패널의 "모두 취소"·"완료 항목 지우기")은 마지막으로 본 상태 그대로 끝난 것으로 친다.
 */
export function waitSettled<T extends { id: string; status: string }>(src: Source<T>, ids: string[], settled: (status: T["status"]) => boolean): Promise<T[]> {
  return new Promise((resolve) => {
    const last = new Map<string, T>();
    const gone = new Set<string>();
    let off: (() => void) | undefined;
    const check = (items: T[]) => {
      // 진행 알림이 초당 수십 번 오므로 id마다 목록을 훑지 않고 한 번만 색인한다
      const byId = new Map(items.map((i) => [i.id, i]));
      for (const id of ids) {
        const it = byId.get(id);
        if (it) last.set(id, it);
        else if (last.has(id)) gone.add(id);
      }
      if (!ids.every((id) => gone.has(id) || (last.has(id) && settled(last.get(id)!.status)))) return false;
      off?.();
      resolve(ids.map((id) => last.get(id)!));
      return true;
    };
    if (!check(src.getSnapshot())) off = src.subscribe(check);
  });
}
