# 무매·VR 주문 데스크 (내 사이트 버전)

SOXL 무한매수법 V4.0과 TQQQ VR의 매일 주문표, 체결 판정, V 갱신을 보여주는 개인용 웹앱입니다.
Claude 없이 돌아가며 비용이 들지 않습니다.

- 화면·계산: 이 폴더의 `index.html`, `engine.js` (GitHub Pages에 올림)
- 로그인·기록 저장: 내 Firebase 프로젝트 (예전 트래커와 같은 프로젝트 `dw02-8988c`)
- 매일 종가: GitHub Actions가 한국시간 화~토 아침 7:30에 받아서 Firebase에 저장

설정은 한 번만 하면 됩니다. 30분 정도 걸려요.

---

## 1. GitHub 저장소 만들고 파일 올리기

1. [github.com](https://github.com)에 가입하고 로그인합니다.
2. 오른쪽 위 **+ → New repository**를 누릅니다.
   - Repository name: `mudesk` (원하는 이름)
   - **Public** 선택 (무료로 GitHub Pages를 쓰려면 공개 저장소여야 합니다)
   - **Create repository**
3. 새 저장소 화면에서 **uploading an existing file** 링크를 누르고, 이 폴더의 파일과 폴더를 **모두** 끌어다 놓습니다.
   - `.github` 폴더(안에 `workflows/prices.yml`)가 꼭 같이 올라가야 합니다. 숨김 폴더라 안 보이면, 탐색기/Finder에서 숨김 파일 보기를 켜세요.
   - 끌어다 놓기로 `.github`가 안 올라가면: 저장소에서 **Add file → Create new file**, 파일 이름에 `.github/workflows/prices.yml`을 입력하고 `prices.yml` 내용을 붙여 넣으세요.
4. 아래 **Commit changes**를 누릅니다.

> 공개 저장소에 올라가는 `firebase-config.js`의 값은 브라우저에 원래 공개되는 설정이라 괜찮습니다.
> 대신 3단계의 **서비스 계정 키(JSON)는 절대 파일로 올리지 마세요.** GitHub Secrets에만 넣습니다.

## 2. Firebase 설정 (콘솔: console.firebase.google.com → 프로젝트 `dw02-8988c`)

1. **Authentication → 로그인 방법**에서 이메일/비밀번호가 켜져 있는지 확인합니다. 예전 트래커를 쓰셨다면 이미 켜져 있습니다.
2. **Firestore Database → 규칙** 탭에 이 폴더의 `firestore.rules` 내용을 통째로 붙여 넣고 **게시**합니다.
   - 예전 트래커 기록(`users/내ID/...`)도 이 규칙으로 계속 열립니다.
3. **Authentication → 설정 → 승인된 도메인 → 도메인 추가**에 `내깃허브아이디.github.io`를 추가합니다. 4단계에서 주소가 정해지면 추가해도 됩니다.

## 3. 종가 자동 업데이트 연결

1. Firebase 콘솔 **⚙ 프로젝트 설정 → 서비스 계정 → 새 비공개 키 생성**을 누르면 JSON 파일이 내려받아집니다.
2. GitHub 저장소 **Settings → Secrets and variables → Actions → New repository secret**을 누릅니다.
   - Name: `FIREBASE_SERVICE_ACCOUNT`
   - Secret: 1번 JSON 파일을 메모장으로 열어 **내용 전체**를 붙여 넣기
   - **Add secret**
3. 내려받은 JSON 파일은 안전한 곳에 보관하거나 지웁니다. 이 키가 있으면 Firebase 데이터 전체에 접근할 수 있습니다.
4. 저장소 **Actions** 탭 → 왼쪽 **종가 업데이트** → **Run workflow**를 눌러 첫 실행을 합니다.
   - 1~2분 뒤 초록색 체크가 뜨면 성공입니다. 눌러 보면 `SOXL: 2026-09-25 종가 151.45` 같은 줄이 보입니다.
   - 빨간 X면 로그를 열어 보세요. `FIREBASE_SERVICE_ACCOUNT 비밀값이 없습니다`는 2번의 이름 오타, `PERMISSION_DENIED`는 키가 다른 프로젝트 것인 경우입니다.

## 4. 사이트 공개하기 (GitHub Pages)

1. 저장소 **Settings → Pages**로 갑니다.
2. Source: **Deploy from a branch**, Branch: **main** / **/(root)** → **Save**.
3. 1~2분 뒤 위쪽에 주소가 나옵니다: `https://내깃허브아이디.github.io/mudesk/`
4. 2-3단계의 승인된 도메인을 아직 안 넣었다면 지금 넣습니다.

## 5. 폰에 앱처럼 설치

- **아이폰(사파리)**: 주소를 열고 → 공유 버튼 → **홈 화면에 추가**
- **안드로이드(크롬)**: 주소를 열고 → ⋮ 메뉴 → **홈 화면에 추가** (또는 **앱 설치**)
- PC는 브라우저 즐겨찾기에 두면 됩니다.

## 6. 처음 쓰기

1. 앱을 열고 **처음이면 계정 만들기**로 이메일·비밀번호 계정을 만듭니다. 예전 트래커 계정이 있으면 그걸로 로그인해도 됩니다.
2. 계좌가 없으면 **내 계좌 두 개 불러오기**를 눌러 SOXL 무매 20/20($54,400)과 VR 1호(V 2,834.39, Pool 300, 37주)를 만듭니다.
3. 매일:
   1. 앱에 뜬 **오늘 밤 주문**대로 증권사에 주문을 넣습니다.
   2. **이대로 주문 넣었어요**를 누릅니다.
   3. 다음 날 아침 종가가 들어오면 체결 판정이 뜹니다. 실제 체결과 맞는지 보고 **계좌에 반영**을 누릅니다.
4. VR은 2주마다 **V 갱신** 카드가 뜨면 누릅니다.

---

## 알아둘 점

- **종가 출처**: Yahoo Finance 차트(실패하면 Stooq). 둘 다 공식 유료 API가 아니라서 가끔 막히거나 늦을 수 있습니다. 그런 날은 앱 아래 **종가 직접 입력**을 쓰면, 내 계정에만 저장되고 자동 종가보다 우선합니다.
- **GitHub 예약 실행**은 몇 분~수십 분 늦게 돌 수 있습니다. 한국시간 8:30에 한 번 더 돌도록 해두었습니다.
- 저장소에 **60일 동안 아무 변경이 없으면** GitHub이 예약 실행을 멈춥니다. 알림 메일이 오면 Actions 탭에서 다시 켜거나, 아무 파일이나 조금 수정해 저장하세요.
- **미국 휴장일**은 자동으로 거르지 않습니다. 휴장일 다음 날 "거래 기록이 없어요"가 뜨면 **이 날 건너뛰기**를 누르세요.
- **무한매수 규칙**은 라오어 V4.0 방법론(일반모드·리버스모드)을 따릅니다. MKS의 보조계단(−5%×7) 대신 방법론의 "1회 매수금 안에서 1주씩 더 사는" 하락 대비 LOC를 씁니다.
- **VR의 G 증가, Pool 한도 변경**은 자동이 아닙니다. 필요할 때 **상태 수정**에서 바꾸세요.
- **다른 사람이 가입하지 못하게 하려면**: 내 계정을 만든 뒤 Firebase 콘솔 **Authentication → 설정 → 사용자 작업** 메뉴가 보이면 거기서 "가입 허용(Enable create)"을 끄세요. 규칙상 다른 사람은 원래 내 기록을 볼 수 없지만, 불필요한 가입을 막을 수 있습니다.

## 파일 설명

| 파일 | 역할 |
|---|---|
| `index.html` | 앱 화면, 로그인, 주문표·체결 판정 |
| `engine.js` | 무한매수 V4.0·VR 계산 엔진 |
| `firebase-config.js` | 내 Firebase 프로젝트 연결 설정 |
| `firestore.rules` | Firestore 보안 규칙 (콘솔에 붙여 넣기용) |
| `manifest.webmanifest`, `sw.js`, `icon-*.png` | 홈 화면 설치용 |
| `scripts/update-prices.mjs` | 종가 받아서 Firestore에 저장 |
| `.github/workflows/prices.yml` | 위 스크립트를 매일 자동 실행 |
