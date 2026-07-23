# 로켓 발사 지도 — 상업 배포 가이드

## 구성 파일

| 파일 | 역할 |
|---|---|
| `rocket_launch_map_Rev0.html` | 앱 본체 (최종본 Rev0) — **Leaflet·MarkerCluster·SheetJS·웹폰트를 전부 내장한 단일 파일. 인터넷 없이도 앱 골격이 뜸(지도 타일·실시간 데이터만 온라인)** |
| `proxy-server_Rev0.js` | 캐싱 프록시 서버 (Node.js, 외부 패키지 불필요) |
| `test_Rev0.html` | 자동 회귀 테스트 러너 (27건) — 프록시 경유 `http://localhost:8787/test_Rev0.html`로 실행 |
| `manifest.webmanifest` | PWA 매니페스트 (폰 홈 화면 추가/설치용) — 프록시가 `/manifest.webmanifest`로 서빙 |
| `icon.svg` | 앱 아이콘(🚀) — 프록시가 `/icon.svg`로 서빙 |

> 📱 **모바일/PWA**: `http(s)`로 접속해야(프록시 경유 또는 클라우드 배포) 홈 화면 추가·설치가 됩니다. 안드로이드 Chrome은 🚀 아이콘으로 설치되고, iOS는 「홈 화면에 추가」로 전체화면 실행됩니다. (iOS 홈 아이콘을 완벽히 하려면 180×180 PNG를 추가하고 `apple-touch-icon`을 그 PNG로 교체 권장 — SVG는 iOS에서 아이콘 렌더가 불안정)

## 실행 모드 (자동 감지)

### 1. 개발·테스트: 파일로 직접 열기 (`file://`)
HTML을 더블클릭해서 열면 기존처럼 동작합니다. **Leaflet·MarkerCluster·SheetJS·웹폰트가 파일 안에 내장돼 있어 CDN이 없어도(인터넷 차단 환경에서도) UI·지도 엔진·마커·차트가 정상 렌더됩니다.**
- 지도: OSM 공개 타일 (개발용만 — OSM 정책상 상업 배포 금지). *타일 이미지 자체는 온라인이 필요하지만, 지도 엔진과 마커 레이아웃은 오프라인에서도 뜸.*
- 데이터: The Space Devs API 직접 호출 — **익명 한도 시간당 15회**라 새로고침 몇 번이면 예시 데이터로 떨어짐

### 2. 상업 배포: 프록시 경유 (`http://`)
```
cd "C:\Users\Edgar Kim\Desktop\실습\rocket-launch-map-Rev0"
node proxy-server_Rev0.js
```
→ 브라우저에서 `http://localhost:8787` 접속.

프록시의 역할:
- **발사 데이터 5분 캐시** — 접속자가 몇 명이든 상위 API 호출은 5분에 1회. 무료 한도(15회/시간) 안에서 무제한 사용자 서비스 가능. 상위 API 장애·한도 초과 시 만료된 캐시로 계속 서비스.
- **타일 7일 캐시 + 키 은닉** — 유료 타일 계약 키를 서버에만 저장 (브라우저에 노출 안 됨).
- **발사장 날씨 15분 캐시** — 발사장별 온도·바람·강수(Open-Meteo). 접속자가 몇 명이든 상위 호출은 발사장당 15분에 1회.

옵션 (환경변수):
```
PORT=8080 node proxy-server_Rev0.js
TILE_UPSTREAM="https://api.maptiler.com/maps/basic/{z}/{x}/{y}.png?key=발급키" node proxy-server_Rev0.js
KMA_SERVICE_KEY="공공데이터포털_기상청_서비스키" node proxy-server_Rev0.js
```
> 🇰🇷 **기상청 공공데이터(나로우주센터 국내 날씨)**: `/kma` 프록시가 기상청 초단기실황을 호출합니다. 서비스키는 현재 `.env`(로컬)·대시보드 환경변수(배포)로 주입되며 `proxy-server_Rev0.js` 소스에는 남기지 않습니다(브라우저엔 노출 안 됨), **운영 배포 시에는 `KMA_SERVICE_KEY` 환경변수로 넣어 소스에 키를 남기지 않는 것을 권장**합니다. 해외 발사장은 Open-Meteo, 국내(나로)만 기상청 → 실패 시 Open-Meteo 자동 폴백.

## 판매 전 남은 체크리스트

- [ ] **타일 공급 계약** — 기본값(OSM 공개 타일)은 데모용. 서비스 개시 전 아래 중 택1 후 `TILE_UPSTREAM` 교체:
  - MapTiler (무료 티어 있음, 상업 플랜 저렴)
  - Stadia Maps (다크 스타일 'Alidade Smooth Dark'가 이 앱 테마와 잘 맞음)
- [ ] **The Space Devs 상업 이용 문의** — API 자체는 무료 공개지만, 상업 제품이라면 후원 티어 가입 또는 공식 문의 권장 (https://thespacedevs.com/llapi)
- [ ] **Open-Meteo 상업 구독** — 발사장 날씨에 사용. 무료 tier는 비상업용(1만회/일)이라, 상업 배포 시 유료 구독(customer-api.open-meteo.com)으로 전환 필요. 데이터 출처 표기(CC BY 4.0)는 앱에 이미 포함 (https://open-meteo.com/en/pricing)
- [x] **CDN 의존성 내장화 — 완료(Rev0)** — Leaflet 1.9.4 / Leaflet.markercluster 1.5.3 / SheetJS 0.18.5 및 웹폰트(Inter·Space Grotesk·JetBrains Mono, latin woff2 base64)를 HTML에 전부 인라인. Leaflet 마커 아이콘 PNG도 data URI로 내장 → 외부 요청 0. 오프라인 키오스크 납품 가능. (한글은 시스템 폰트 폴백, latin-ext는 용량상 제외)
- [ ] **저작권 등록** — 한국저작권위원회 컴퓨터프로그램 등록
- [ ] **라이선스 고지 유지** — 지도 우하단 OpenStreetMap 저작자 표시는 삭제 금지 (ODbL 의무)

## 라이선스 현황 (2026-07 기준)

| 구성요소 | 라이선스 | 상업 이용 |
|---|---|---|
| Leaflet | BSD-2 | ✅ (내장 재배포 허용) |
| Leaflet.markercluster | MIT | ✅ (내장 재배포 허용) |
| SheetJS CE | Apache-2.0 | ✅ (내장 재배포 허용) |
| Google Fonts (Inter·Space Grotesk·JetBrains Mono) | OFL 1.1 | ✅ (임베드/재배포 허용, 폰트 판매만 금지) |
| OSM 데이터/타일 | ODbL / 정책 | 데이터 ✅ (저작자 표시), 공개 타일 서버는 상업 배포 ❌ → 유료 공급자 교체 |
| ~~CARTO 타일~~ | 비상업 전용 | ❌ → **제거 완료** |
| The Space Devs LL2 | 무료 공개 | 한도 있음 → 프록시 캐시로 해결, 상업 문의 권장 |
| Open-Meteo (날씨) | CC BY 4.0 (데이터) | 비상업 무료 / 상업은 유료 구독 → 판매 전 전환, 출처 표기 유지 |
