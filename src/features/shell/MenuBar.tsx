import { useState } from "react";
import { checkForUpdate } from "./updater";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Menubar, MenubarCheckboxItem, MenubarContent, MenubarItem, MenubarMenu, MenubarRadioGroup, MenubarRadioItem, MenubarSeparator, MenubarShortcut, MenubarSub, MenubarSubContent, MenubarSubTrigger, MenubarTrigger } from "@/components/ui/menubar";
import type { Sort, SortKey, ViewMode } from "@/features/browse/FileList";
import pkg from "../../../package.json";
import { isTauri, modKey } from "./platform";

export interface MenuActions {
  newFolder(): void;
  upload(): void;
  /** 데스크톱 앱에서만 */
  uploadFolder?(): void;
  /** 선택 항목이 있을 때만 활성 */
  selection: { count: number; hasFile: boolean };
  /** 읽기 전용 저장소: 새 폴더·업로드·이름 변경·삭제를 끈다 */
  readOnly: boolean;
  download(): void;
  share(): void;
  rename(): void;
  remove(): void;
  selectAll(): void;
  clearSelection(): void;
  view: ViewMode;
  setView(v: ViewMode): void;
  sidebarOpen: boolean;
  toggleSidebar(): void;
  detailsOpen: boolean;
  toggleDetails(): void;
  refresh(): void;
  sort: Sort;
  setSort(s: Sort): void;
  back(): void;
  forward(): void;
  up(): void;
  canBack: boolean;
  canForward: boolean;
  canUp: boolean;
  logout(): void;
  settings(): void;
  trash(): void;
  shareLinks(): void;
  /** 바로 보내기. 설치된 앱에서만(없으면 메뉴 항목을 숨긴다) */
  nearby?(): void;
}

const MOD = modKey();

/** 프로그램식 메뉴바: 파일 · 편집 · 보기 · 이동 · 도움말 */
export function MenuBar(a: MenuActions) {
  const [dialog, setDialog] = useState<"shortcuts" | "about" | null>(null);
  const has = a.selection.count > 0;
  const quit = () => (isTauri() ? void import("@tauri-apps/api/core").then(({ invoke }) => invoke("quit")) : window.close());
  const item = "text-sm";
  return (
    <>
      <Menubar className="h-7 gap-0 rounded-none border-0 bg-transparent p-0 shadow-none">
        <MenubarMenu>
          <MenubarTrigger className="h-7 rounded-md px-2.5 text-sm font-normal">파일</MenubarTrigger>
          <MenubarContent className="min-w-56">
            <MenubarItem disabled={a.readOnly} onClick={a.newFolder} className={item}>
              새 폴더<MenubarShortcut>{MOD}+Shift+N</MenubarShortcut>
            </MenubarItem>
            <MenubarItem disabled={a.readOnly} onClick={a.upload} className={item}>
              파일 업로드…
            </MenubarItem>
            {a.uploadFolder && (
              <MenubarItem disabled={a.readOnly} onClick={a.uploadFolder} className={item}>
                폴더 업로드…
              </MenubarItem>
            )}
            <MenubarItem onClick={a.trash} className={item}>
              휴지통…
            </MenubarItem>
            <MenubarSeparator />
            <MenubarItem disabled={!a.selection.hasFile} onClick={a.download} className={item}>
              다운로드
            </MenubarItem>
            <MenubarItem disabled={a.selection.count !== 1} onClick={a.share} className={item}>
              공유 링크…
            </MenubarItem>
            {a.nearby && (
              <MenubarItem onClick={a.nearby} className={item}>
                바로 보내기…
              </MenubarItem>
            )}
            <MenubarItem onClick={a.shareLinks} className={item}>
              공유 링크 관리…
            </MenubarItem>
            <MenubarItem disabled={a.readOnly || a.selection.count !== 1} onClick={a.rename} className={item}>
              이름 변경<MenubarShortcut>F2</MenubarShortcut>
            </MenubarItem>
            <MenubarItem disabled={a.readOnly || !has} onClick={a.remove} variant="destructive" className={item}>
              삭제<MenubarShortcut>Del</MenubarShortcut>
            </MenubarItem>
            <MenubarSeparator />
            <MenubarItem onClick={a.settings} className={item}>
              설정…<MenubarShortcut>{MOD}+,</MenubarShortcut>
            </MenubarItem>
            <MenubarItem onClick={a.logout} className={item}>
              로그아웃
            </MenubarItem>
            <MenubarItem onClick={quit} className={item}>
              종료
            </MenubarItem>
          </MenubarContent>
        </MenubarMenu>

        <MenubarMenu>
          <MenubarTrigger className="h-7 rounded-md px-2.5 text-sm font-normal">편집</MenubarTrigger>
          <MenubarContent className="min-w-48">
            <MenubarItem onClick={a.selectAll} className={item}>
              모두 선택<MenubarShortcut>{MOD}+A</MenubarShortcut>
            </MenubarItem>
            <MenubarItem disabled={!has} onClick={a.clearSelection} className={item}>
              선택 해제<MenubarShortcut>Esc</MenubarShortcut>
            </MenubarItem>
          </MenubarContent>
        </MenubarMenu>

        <MenubarMenu>
          <MenubarTrigger className="h-7 rounded-md px-2.5 text-sm font-normal">보기</MenubarTrigger>
          <MenubarContent className="min-w-48">
            <MenubarRadioGroup value={a.view} onValueChange={(v) => a.setView(v as ViewMode)}>
              <MenubarRadioItem value="list" className={item}>
                목록
              </MenubarRadioItem>
              <MenubarRadioItem value="grid" className={item}>
                아이콘
              </MenubarRadioItem>
            </MenubarRadioGroup>
            <MenubarSeparator />
            <MenubarSub>
              <MenubarSubTrigger className={item}>정렬 기준</MenubarSubTrigger>
              <MenubarSubContent>
                <MenubarRadioGroup value={a.sort.key} onValueChange={(k) => a.setSort({ ...a.sort, key: k as SortKey })}>
                  <MenubarRadioItem value="name" className={item}>
                    이름
                  </MenubarRadioItem>
                  <MenubarRadioItem value="mtime" className={item}>
                    수정일
                  </MenubarRadioItem>
                  <MenubarRadioItem value="size" className={item}>
                    크기
                  </MenubarRadioItem>
                </MenubarRadioGroup>
                <MenubarSeparator />
                <MenubarRadioGroup value={a.sort.dir} onValueChange={(d) => a.setSort({ ...a.sort, dir: d as Sort["dir"] })}>
                  <MenubarRadioItem value="asc" className={item}>
                    오름차순
                  </MenubarRadioItem>
                  <MenubarRadioItem value="desc" className={item}>
                    내림차순
                  </MenubarRadioItem>
                </MenubarRadioGroup>
              </MenubarSubContent>
            </MenubarSub>
            <MenubarSeparator />
            <MenubarCheckboxItem checked={a.sidebarOpen} onCheckedChange={a.toggleSidebar} className={item}>
              사이드바
            </MenubarCheckboxItem>
            <MenubarCheckboxItem checked={a.detailsOpen} onCheckedChange={a.toggleDetails} className={item}>
              세부 정보 창
            </MenubarCheckboxItem>
            <MenubarItem onClick={a.refresh} className={item}>
              새로고침<MenubarShortcut>F5</MenubarShortcut>
            </MenubarItem>
          </MenubarContent>
        </MenubarMenu>

        <MenubarMenu>
          <MenubarTrigger className="h-7 rounded-md px-2.5 text-sm font-normal">이동</MenubarTrigger>
          <MenubarContent className="min-w-48">
            <MenubarItem disabled={!a.canBack} onClick={a.back} className={item}>
              뒤로<MenubarShortcut>Alt+←</MenubarShortcut>
            </MenubarItem>
            <MenubarItem disabled={!a.canForward} onClick={a.forward} className={item}>
              앞으로<MenubarShortcut>Alt+→</MenubarShortcut>
            </MenubarItem>
            <MenubarItem disabled={!a.canUp} onClick={a.up} className={item}>
              상위 폴더<MenubarShortcut>Backspace</MenubarShortcut>
            </MenubarItem>
          </MenubarContent>
        </MenubarMenu>

        <MenubarMenu>
          <MenubarTrigger className="h-7 rounded-md px-2.5 text-sm font-normal">도움말</MenubarTrigger>
          <MenubarContent className="min-w-48">
            <MenubarItem onClick={() => setDialog("shortcuts")} className={item}>
              키보드 단축키
            </MenubarItem>
            <MenubarItem onClick={() => void checkForUpdate(true)} className={item}>
              업데이트 확인…
            </MenubarItem>
            <MenubarItem onClick={() => setDialog("about")} className={item}>
              U-Drive 정보
            </MenubarItem>
          </MenubarContent>
        </MenubarMenu>
      </Menubar>

      <Dialog open={dialog === "shortcuts"} onOpenChange={(o) => !o && setDialog(null)}>
        <DialogContent showCloseButton className="text-sm">
          <DialogHeader>
            <DialogTitle>키보드 단축키</DialogTitle>
            <DialogDescription>파일 목록에서 사용할 수 있는 키입니다.</DialogDescription>
          </DialogHeader>
          <table className="w-full text-sm">
            <tbody>
              {[
                ["↑ ↓ Home End", "항목 이동"],
                ["Shift+↑/↓", "범위 선택"],
                [`${MOD}+클릭`, "개별 선택 추가"],
                ["Enter", "열기"],
                ["Backspace", "상위 폴더"],
                ["Alt+← / Alt+→", "뒤로 / 앞으로"],
                ["F2", "이름 변경"],
                ["Delete", "삭제"],
                [`${MOD}+A`, "모두 선택"],
                [`${MOD}+Shift+N`, "새 폴더"],
                ["F5", "새로고침"],
                ["Esc", "선택 해제 / 닫기"],
              ].map(([k, v]) => (
                <tr key={k} className="h-7 border-b border-border last:border-0">
                  <td className="w-40 font-mono text-xs text-muted-foreground">{k}</td>
                  <td>{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === "about"} onOpenChange={(o) => !o && setDialog(null)}>
        <DialogContent showCloseButton className="text-sm sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>U-Drive</DialogTitle>
            <DialogDescription>버전 {pkg.version}</DialogDescription>
          </DialogHeader>
          <p className="text-xs text-muted-foreground">
            Seafile 서버를 백엔드로 쓰는 커스텀 파일 탐색기입니다.
            <br />
            Seafile 웹 API 위에 데스크톱 앱(Tauri · React)으로 만들었습니다.
          </p>
          <div className="flex justify-end">
            <Button size="sm" onClick={() => setDialog(null)}>
              확인
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
