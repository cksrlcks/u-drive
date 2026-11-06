// 추상화 누수 + 디자인 토큰 위반 검사. 위반이 있으면 종료 코드 1.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.ts$/.test(name)) out.push(p);
  }
  return out;
}
const rel = (p) => relative(root, p).replace(/\\/g, "/");

let failed = false;

// 1) "seafile"은 src/storage/seafile/ 와 Connection.kind 분기 지점(StorageProvider.ts, createProvider.ts),
//    기본 URL(session.ts, LoginScreen.tsx) 밖에 나오면 안 된다.
const storageAllow = [
  /^src\/storage\/seafile\//,
  /^src\/storage\/StorageProvider\.ts$/,
  /^src\/storage\/createProvider\.ts$/,
  /^src\/storage\/session\.ts$/,
  // 서버 종류 자동 판별(ping 헤더)이 종류 이름을 돌려준다
  /^src\/storage\/detect\.ts$/,
  // 정보 대화상자의 제품 설명 문구(사용자에게 보여 주는 이름이지 코드 분기가 아니다)
  /^src\/features\/shell\/MenuBar\.tsx$/,
];
for (const f of walk(join(root, "src"))) {
  const r = rel(f);
  if (storageAllow.some((re) => re.test(r))) continue;
  if (/seafile/i.test(readFileSync(f, "utf8"))) {
    console.error(`storage leak: ${r}`);
    failed = true;
  }
}

// 2) src/features, src/App.tsx 안에 원시 색/임의값/팔레트 직접 참조 금지.
const designRe = /#[0-9a-fA-F]{3,6}\b|\b(bg|text|border)-\[|-(gray|slate|zinc|neutral|stone|blue|red|green)-[0-9]/;
for (const f of [...walk(join(root, "src/features")), join(root, "src/App.tsx")]) {
  const lines = readFileSync(f, "utf8").split("\n");
  lines.forEach((line, i) => {
    if (designRe.test(line)) {
      console.error(`design token violation: ${rel(f)}:${i + 1}: ${line.trim()}`);
      failed = true;
    }
  });
}

if (failed) process.exit(1);
console.log("lint ok");
