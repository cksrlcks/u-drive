import { IconBuildingBroadcastTower, IconChevronDown, IconCloud, IconLink, IconLock, IconPencil, IconStar, IconStarOff, IconTrash } from "@tabler/icons-react";
import { cn } from "cn";
import { useState, type ReactNode } from "react";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";
import type { Library } from "@/storage/StorageProvider";
import { InlineName } from "./InlineName";
import type { Location } from "./useCurrentDir";

interface Props {
  libraries: Library[] | undefined;
  loc: Location;
  onNavigate(loc: Location): void;
  onRenameLibrary(lib: Library, newName: string): void;
  onStarLibrary(lib: Library, starred: boolean): void;
  width: number;
  /** 현재 저장소의 휴지통 열기 */
  onTrash(): void;
  /** 메인 영역에 무엇이 떠 있는지. 파일 탐색이 아니면 저장소 행을 선택 표시하지 않는다 */
  page: "files" | "links" | "trash";
  onShareLinks(): void;
  /** 바로 보내기 창 열기. 설치된 앱에서만(없으면 숨김) */
  onSend?(): void;
}

const COLLAPSED_KEY = "seadrive.sidebar.collapsed";

/** 접은 섹션 이름들. localStorage에 기억 */
function useCollapsed() {
  const [collapsed, setCollapsed] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]") as string[];
    } catch {
      return [];
    }
  });
  const toggle = (s: string) =>
    setCollapsed((c) => {
      const next = c.includes(s) ? c.filter((x) => x !== s) : [...c, s];
      try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  return [collapsed, toggle] as const;
}

/** macOS 소스 리스트 스타일: 연회색, 11px 섹션 라벨, 28px 행, 선택은 옅은 파란 틴트. 탐색기처럼 저장소만 두고 폴더 트리는 없다 */
export function Sidebar({ libraries, loc, onNavigate, onRenameLibrary, onStarLibrary, width, onTrash, page, onShareLinks, onSend }: Props) {
  /** 이름 변경 중인 저장소 id */
  const [renaming, setRenaming] = useState<string | null>(null);
  const [collapsed, toggleSection] = useCollapsed();
  const names = libraries?.map((l) => l.name) ?? [];
  // 즐겨찾기 → 내 저장소 → 나에게 공유됨. 즐겨찾기한 저장소는 원래 섹션에도 그대로 둔다
  const sections = new Map<string, Library[]>([["즐겨찾기", []], ["내 저장소", []]]);
  for (const l of libraries ?? []) {
    for (const s of l.starred ? ["즐겨찾기", l.section] : [l.section]) sections.set(s, [...(sections.get(s) ?? []), l]);
  }
  for (const libs of sections.values()) libs.sort((a, b) => a.name.localeCompare(b.name, "ko"));
  // 같은 저장소가 두 섹션에 있으면 선택 표시는 클릭한 쪽에만
  const [clickedIn, setClickedIn] = useState<string | null>(null);
  return (
    <aside style={{ width }} className="flex shrink-0 flex-col overflow-y-auto border-r border-border bg-sidebar px-2 pt-2 pb-2">
      {[...sections].filter(([, libs]) => libs.length > 0).map(([section, libs], i) => (
        <div key={section} className={cn(i > 0 && "mt-3")}>
          <button type="button" onClick={() => toggleSection(section)} className="group/sec mb-1 flex w-full items-center gap-1 px-2 pt-1 text-2xs font-medium text-muted-foreground">
            {section}
            <IconChevronDown className={cn("size-3 opacity-0 transition-transform group-hover/sec:opacity-100", collapsed.includes(section) && "-rotate-90 opacity-100")} />
          </button>
          {!collapsed.includes(section) && libs.map((lib) => {
            if (lib.encrypted) return <Row key={lib.id} icon={<IconLock className="size-4" />} label={lib.name} disabled title="암호화된 저장소는 지원하지 않습니다" />;
            const active = loc.libId === lib.id && (!lib.starred || (clickedIn ?? "즐겨찾기") === section);
            return (
              <div key={lib.id}>
                {renaming === lib.id ? (
                  <div className="my-px pl-7">
                    <InlineName
                      initial={lib.name}
                      existing={names.filter((n) => n !== lib.name)}
                      onSubmit={(n) => {
                        setRenaming(null);
                        onRenameLibrary(lib, n);
                      }}
                      onCancel={() => setRenaming(null)}
                      className="h-7 text-sm md:text-sm"
                    />
                  </div>
                ) : (
                  <RowMenu onRename={lib.section === "내 저장소" ? () => setRenaming(lib.id) : undefined} star={lib.nas ? undefined : { starred: !!lib.starred, onToggle: () => onStarLibrary(lib, !lib.starred) }}>
                    {/* 저장소 = 드라이브 루트. 하위 폴더에 있어도 그 저장소를 선택 표시 */}
                    <Row icon={<IconCloud className="size-4" />} label={lib.name} selected={page === "files" && active} onClick={() => {
                        setClickedIn(section);
                        onNavigate({ libId: lib.id, path: "/" });
                      }} />
                  </RowMenu>
                )}
              </div>
            );
          })}
        </div>
      ))}
      <div className="mt-auto border-t border-sidebar-border pt-2">
        {onSend && <Row icon={<IconBuildingBroadcastTower className="size-4" />} label="바로 보내기" title="같은 네트워크의 U-Drive 사용자에게 파일을 바로 보냅니다" onClick={onSend} />}
        <Row icon={<IconLink className="size-4" />} label="공유 링크" selected={page === "links"} onClick={onShareLinks} />
        <Row icon={<IconTrash className="size-4" />} label="휴지통" selected={page === "trash"} disabled={loc.libId === null} title={loc.libId === null ? "저장소를 먼저 선택하세요" : undefined} onClick={onTrash} />
      </div>
    </aside>
  );
}

/** 우클릭 → 즐겨찾기 · 이름 변경(공유받은 저장소는 없음) */
function RowMenu({ onRename, star, children }: { onRename?(): void; star?: { starred: boolean; onToggle(): void }; children: ReactNode }) {
  return (
    <ContextMenu>
      <ContextMenuTrigger render={<div />}>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        {star && (
          <ContextMenuItem onClick={star.onToggle} className="text-sm">
            {star.starred ? <IconStarOff className="size-4" /> : <IconStar className="size-4" />} {star.starred ? "즐겨찾기 해제" : "즐겨찾기에 추가"}
          </ContextMenuItem>
        )}
        {onRename && (
          <ContextMenuItem onClick={onRename} className="text-sm">
            <IconPencil className="size-4" /> 이름 변경
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

function Row({ icon, label, selected, disabled, title, onClick }: { icon: ReactNode; label: string; selected?: boolean; disabled?: boolean; title?: string; onClick?(): void }) {
  return (
    <div
      role="treeitem"
      aria-selected={selected}
      title={title ?? label}
      onClick={disabled ? undefined : onClick}
      className={cn(
        "my-px flex h-8 cursor-default items-center gap-2 rounded-md pr-2 pl-2 text-sm font-medium text-foreground",
        !disabled && !selected && "hover:bg-sidebar-accent",
        selected && "bg-selection",
        disabled && "text-muted-foreground",
      )}
    >
      <span className={cn("shrink-0", selected ? "text-primary" : "text-muted-foreground")}>{icon}</span>
      <span className="truncate">{label}</span>
    </div>
  );
}
