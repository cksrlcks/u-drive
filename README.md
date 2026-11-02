# U-Drive

[Seafile](https://www.seafile.com/) 서버에 붙는 데스크톱 파일 관리 앱입니다. Windows·macOS·Ubuntu용으로, 웹 화면 대신 탐색기·Finder처럼 파일을 올리고 받고 정리할 수 있습니다.

Tauri 2 + React 19 + TypeScript(Vite)로 만들었습니다.

## 설치

[Releases](https://github.com/cksrlcks/u-drive/releases/latest)에서 받습니다.

| OS | 파일 |
| --- | --- |
| Windows | `Drive_<버전>_x64-setup.exe` |
| macOS (Apple Silicon·Intel) | `Drive_<버전>_universal.dmg` |
| Ubuntu 22.04+ (x64) | `Drive_<버전>_amd64.deb` 또는 `Drive_<버전>_amd64.AppImage` |

macOS는 ad-hoc 서명이라 처음 한 번 **시스템 설정 → 개인정보 보호 및 보안 → 그래도 열기**가 필요합니다. 자세한 내용은 [docs/macos-release.md](docs/macos-release.md).

설치한 뒤에는 앱이 새 버전을 스스로 확인하고 업데이트합니다. Ubuntu deb는 업데이트할 때 관리자 암호를 한 번 묻습니다.

## Claude 연결

Claude에서 "이 문서 유드라이브에 올려줘", "유드라이브에서 ○○ 받아줘"처럼 말로 파일을 올리고 받을 수 있습니다. 위의 U-Drive 앱이 설치돼 있고 로그인돼 있어야 합니다.

**Claude Code** — 터미널에서 한 번 실행합니다.

```
claude plugin marketplace add cksrlcks/u-drive
claude plugin install u-drive@u-drive
```

**Claude 데스크톱 앱**

1. [u-drive.mcpb](https://github.com/cksrlcks/u-drive/raw/main/claude-plugin/u-drive.mcpb)를 받습니다. U-Drive 설정 → Claude 연결의 받기 버튼도 같은 파일입니다.
2. Claude 데스크톱 앱에서 설정을 엽니다.
3. 왼쪽 목록의 이 컴퓨터 아래에 있는 확장 프로그램을 누릅니다.
4. 받은 u-drive.mcpb 파일을 확장 프로그램 화면에 끌어다 놓고, 뜨는 창에서 설치를 누릅니다.
5. Claude 대화에서 "유드라이브 저장소 목록 보여줘"라고 해서 목록이 나오면 연결된 것입니다.

플러그인 파일은 [claude-plugin/](claude-plugin/)에 있습니다. `mcpb/manifest.json`을 고치면 그 폴더에서 `npx @anthropic-ai/mcpb pack . ../u-drive.mcpb`로 다시 만듭니다.

## 기능

- **로그인**: 서버 주소 지정, 2단계 인증, 자동 로그인
- **탐색**: 저장소를 내 저장소·그룹·나에게 공유됨으로 나눠 표시, 목록/아이콘 보기, 열 크기 조절·정렬, 드래그 선택, 키보드 탐색, OS 파일 아이콘
- **파일 작업**: 새 폴더, 이름 변경, 삭제, 우클릭 메뉴
- **업로드**: 끌어다 놓기, 큰 파일 분할·이어 올리기, 동시 업로드·재시도·취소
- **다운로드**: 저장 위치 선택, 진행 패널, 폴더에서 보기
- **미리보기**: 이미지·텍스트·PDF
- **검색**: 하위 폴더까지, 모든 저장소 통합 검색
- **공유 링크**: 비밀번호·만료일 지정, 링크 관리 페이지
- **휴지통**: 복원·비우기
- **트레이**: 창을 닫으면 트레이(메뉴 막대)로 숨김, 트레이 메뉴에서 업로드·새로고침·종료

## 서버 쪽 준비: CORS

앱은 WebView에서 Seafile API를 직접 부르므로 서버에 CORS 설정이 필요합니다. 로그인할 때 "서버에 연결할 수 없습니다. 서버 주소와 CORS 설정을 확인하세요"가 뜨면 이 부분을 확인하세요.

- nginx: [docs/nginx-cors.conf](docs/nginx-cors.conf)
- Traefik: [docs/traefik-cors.yml](docs/traefik-cors.yml)
- Dokploy(Seafile 템플릿): [docs/dokploy-cors.md](docs/dokploy-cors.md)

## 개발

필요한 것: Node 22, Rust stable, [Tauri 사전 준비물](https://tauri.app/start/prerequisites/)

```bash
npm install
npm run tauri dev   # 데스크톱 앱으로 실행
npm run dev         # 브라우저에서 화면만 (http://localhost:1420)
npm test            # vitest
npm run lint        # 저장소 추상화 누수·디자인 토큰 위반 검사
```

서버 없이 화면을 확인하려면 로그인 화면의 서버 주소에 `mock`을 넣습니다. 인메모리 가짜 백엔드로 동작합니다.

### 구조

```
src/
  storage/          StorageProvider 인터페이스와 구현 (seafile, mock)
  features/         화면 기능별 폴더 (auth, browse, upload, download, share, trash, search …)
  components/ui/    shadcn 기반 공용 컴포넌트
src-tauri/          Rust 쪽: 트레이, OS 파일 아이콘, 플러그인(updater·dialog·upload)
docs/               디자인 규칙(DESIGN.md), 배포·CORS 안내
```

화면 코드는 `StorageProvider`만 거치고 Seafile API를 직접 부르지 않습니다(`npm run lint`가 검사). UI를 바꿀 때는 [docs/DESIGN.md](docs/DESIGN.md)의 규칙을 따릅니다.

## 릴리스

1. `package.json`의 `version`을 올립니다 (앱 버전은 여기서 읽습니다).
2. [CHANGELOG.md](CHANGELOG.md) 위쪽에 `## v<버전>` 섹션을 씁니다. 첫 줄은 한 문장 요약(앱 업데이트 알림에 나옴)이고, 섹션 전체가 릴리스 본문이 됩니다. 섹션이 없으면 빌드가 실패합니다.
3. main에 커밋·푸시하고 `gh workflow run release.yml --ref main`으로 릴리스를 시작합니다. `v<버전>` 태그는 워크플로가 만듭니다(태그를 직접 푸시하지 않습니다).
4. [release.yml](.github/workflows/release.yml)이 Windows·macOS·Ubuntu를 빌드·서명해 초안 릴리스에 올리고, 모두 끝나면 공개합니다. 설치된 앱은 `latest.json`을 보고 업데이트합니다.

필요한 GitHub 시크릿: `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. macOS 정식 서명·공증용 시크릿은 [docs/macos-release.md](docs/macos-release.md)를 보세요.
