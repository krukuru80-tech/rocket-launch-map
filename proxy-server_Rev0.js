// ============================================================================
// 로켓 발사 지도 — 캐싱 프록시 서버 (상업 배포용)
// ----------------------------------------------------------------------------
// 역할:
//  1) rocket_launch_map_Rev0.html 서빙  (http://localhost:8787/)
//  2) /api/*   → The Space Devs LL2 API 프록시 + 5분 캐시
//                → 접속자가 몇 명이든 상위 API 호출은 5분에 1회로 고정되어
//                  무료 호출 한도(시간당 15회)를 절대 넘지 않음
//  3) /tiles/* → 지도 타일 프록시 + 7일 캐시
//                → 타일 공급 계약(MapTiler/Stadia 등)의 API 키를 이 파일에만 두면
//                  브라우저(고객)에게 키가 노출되지 않음
//  4) /weather/* → 발사장 날씨(Open-Meteo) 프록시 + 15분 캐시
//                → 전 세계 발사장 좌표 기반 온도·바람·강수. Open-Meteo는 API 키가 없음.
//                  ⚠️ 무료 tier는 비상업용 — 상업 배포 시 유료 구독으로 교체.
//  4-b) /kma    → 국내 발사장(나로) 기상청 초단기실황 + 10분 캐시
//                → 서비스키(공공데이터포털)를 이 파일에만 두어 브라우저에 노출 안 됨.
//
// 실행:   node proxy-server.js
// 옵션:   PORT=8080 node proxy-server.js
//         TILE_UPSTREAM="https://api.maptiler.com/maps/basic/{z}/{x}/{y}.png?key=발급키" node proxy-server.js
//
// ⚠️ 기본 TILE_UPSTREAM은 OSM 공개 타일입니다. OSM 정책상 개발·데모용으로만 쓰고,
//    상업 서비스 개시 전 반드시 유료 타일 공급자로 교체하세요.
// ============================================================================
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

// .env 파일이 있으면 로드 (로컬 개발용 — 외부 패키지 불필요). 배포 환경은 대시보드 환경변수를 사용.
// .env 는 .gitignore 로 저장소에서 제외되므로 서비스키가 공개 저장소에 올라가지 않는다.
try {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
} catch (e) { /* .env 없거나 읽기 실패 시 무시 */ }

const PORT = Number(process.env.PORT) || 8787;
const HTML_FILE = process.env.HTML_FILE || path.join(__dirname, 'rocket_launch_map_Rev0.html');
const API_UPSTREAM = 'https://ll.thespacedevs.com';
const TILE_UPSTREAM = process.env.TILE_UPSTREAM || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const WX_UPSTREAM = 'https://api.open-meteo.com';   // 발사장 날씨 (전 세계, API 키 불필요)
// 기상청 초단기실황 (국내 발사장 날씨 — 공공데이터포털). 서비스키는 여기(서버)에만 두어 브라우저에 노출 안 됨.
// 운영 배포 시에는 KMA_SERVICE_KEY 환경변수로 넣는 것을 권장(소스에 키를 남기지 않기 위해).
const KMA_UPSTREAM = 'http://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getUltraSrtNcst';
const KMA_SERVICE_KEY = process.env.KMA_SERVICE_KEY || '';   // .env(로컬) 또는 대시보드 환경변수(배포)에서 주입
const USER_AGENT = 'RocketLaunchMap/1.0 (caching proxy; contact: edgar.kim@jeju-semi.com)';

const API_TTL = 5 * 60 * 1000;            // 발사 데이터: 5분
const TILE_TTL = 7 * 24 * 60 * 60 * 1000; // 지도 타일: 7일
const WX_TTL = 15 * 60 * 1000;            // 날씨(Open-Meteo): 15분
const KMA_TTL = 10 * 60 * 1000;           // 기상청 실황: 10분
const TILE_CACHE_MAX = 4000;              // 타일 메모리 캐시 상한 (초과 시 오래된 것부터 제거)

const apiCache = new Map();   // url -> { ts, status, type, body }
const tileCache = new Map();  // url -> { ts, status, type, body }
const wxCache = new Map();    // url -> { ts, status, type, body }
const kmaCache = new Map();   // url -> { ts, status, type, body }

// 위경도 → 기상청 격자(nx,ny) [Lambert Conformal Conic, 기상청 표준 DFS 변환]
function dfsXyConv(lat, lon){
  const RE=6371.00877, GRID=5.0, SLAT1=30.0, SLAT2=60.0, OLON=126.0, OLAT=38.0, XO=43, YO=136;
  const D=Math.PI/180;
  const re=RE/GRID, slat1=SLAT1*D, slat2=SLAT2*D, olon=OLON*D, olat=OLAT*D;
  let sn=Math.tan(Math.PI*0.25+slat2*0.5)/Math.tan(Math.PI*0.25+slat1*0.5);
  sn=Math.log(Math.cos(slat1)/Math.cos(slat2))/Math.log(sn);
  let sf=Math.tan(Math.PI*0.25+slat1*0.5); sf=Math.pow(sf,sn)*Math.cos(slat1)/sn;
  let ro=Math.tan(Math.PI*0.25+olat*0.5); ro=re*sf/Math.pow(ro,sn);
  let ra=Math.tan(Math.PI*0.25+lat*D*0.5); ra=re*sf/Math.pow(ra,sn);
  let theta=lon*D-olon; if(theta>Math.PI)theta-=2*Math.PI; if(theta<-Math.PI)theta+=2*Math.PI; theta*=sn;
  return { nx: Math.floor(ra*Math.sin(theta)+XO+0.5), ny: Math.floor(ro-ra*Math.cos(theta)+YO+0.5) };
}
// 기상청 초단기실황 base_date/base_time (KST 기준; 실황은 정시 생성·HH40 이후 제공 → 40분 이전이면 직전 시각)
function kmaBaseDateTime(){
  const kst = new Date(Date.now() + 9*3600*1000);   // 서버 타임존과 무관하게 KST 벽시계 계산
  let y=kst.getUTCFullYear(), mo=kst.getUTCMonth(), da=kst.getUTCDate(), h=kst.getUTCHours();
  if (kst.getUTCMinutes() < 40){
    const prev = new Date(Date.UTC(y,mo,da,h) - 3600*1000);
    y=prev.getUTCFullYear(); mo=prev.getUTCMonth(); da=prev.getUTCDate(); h=prev.getUTCHours();
  }
  const p=n=>String(n).padStart(2,'0');
  return { baseDate: ''+y+p(mo+1)+p(da), baseTime: p(h)+'00' };
}

function log(...a){ console.log(new Date().toISOString().slice(11,19), ...a); }

async function fetchUpstream(url){
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, 'Accept': '*/*' } });
  const body = Buffer.from(await res.arrayBuffer());
  return { status: res.status, type: res.headers.get('content-type') || 'application/octet-stream', body };
}

// 캐시 우선 조회 → 만료 시 상위 호출 → 상위 실패(429/5xx/네트워크)면 만료된 캐시라도 재사용
async function cachedFetch(cache, url, ttl){
  const hit = cache.get(url);
  const now = Date.now();
  if (hit && (now - hit.ts) < ttl) return { ...hit, cached: true };
  try{
    const fresh = await fetchUpstream(url);
    if (fresh.status >= 200 && fresh.status < 400){
      cache.set(url, { ts: now, ...fresh });
      return { ...fresh, cached: false };
    }
    if (hit) return { ...hit, cached: true, stale: true };   // 상위 오류 → 만료 캐시로 버팀
    return fresh;
  }catch(err){
    if (hit) return { ...hit, cached: true, stale: true };
    throw err;
  }
}

function trimTileCache(){
  while (tileCache.size > TILE_CACHE_MAX){
    const oldest = tileCache.keys().next().value;
    tileCache.delete(oldest);
  }
}

function send(res, status, type, body, extra){
  res.writeHead(status, Object.assign({ 'Content-Type': type, 'Cache-Control': 'public, max-age=300' }, extra || {}));
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  try{
    const u = new URL(req.url, 'http://localhost');

    // ---- 1) 앱 HTML ----
    if (u.pathname === '/' || u.pathname === '/index.html'){
      const html = fs.readFileSync(HTML_FILE);
      return send(res, 200, 'text/html; charset=utf-8', html, { 'Cache-Control': 'no-cache' });
    }

    // ---- 2) 발사 데이터 API 프록시 (5분 캐시) ----
    if (u.pathname.startsWith('/api/')){
      const upstream = API_UPSTREAM + u.pathname.slice(4) + (u.search || '');
      const r = await cachedFetch(apiCache, upstream, API_TTL);
      log('API ', r.cached ? (r.stale ? 'STALE' : 'CACHE') : 'LIVE ', upstream);
      return send(res, r.status, r.type, r.body);
    }

    // ---- 3) 지도 타일 프록시 (7일 캐시) ----
    const tileMatch = u.pathname.match(/^\/tiles\/(\d{1,2})\/(\d{1,7})\/(\d{1,7})\.png$/);
    if (tileMatch){
      const [ , z, x, y ] = tileMatch;
      const upstream = TILE_UPSTREAM.replace('{z}', z).replace('{x}', x).replace('{y}', y);
      const r = await cachedFetch(tileCache, upstream, TILE_TTL);
      trimTileCache();
      return send(res, r.status, r.type, r.body, { 'Cache-Control': 'public, max-age=86400' });
    }

    // ---- 4) 날씨 프록시 (Open-Meteo, 15분 캐시) ----
    //   접속자가 몇 명이든 발사장별 상위 호출은 15분에 1회로 고정.
    //   ⚠️ Open-Meteo 무료 tier는 비상업용입니다. 상업 배포 시 유료 구독(customer-api)으로 교체하세요.
    if (u.pathname.startsWith('/weather/')){
      const upstream = WX_UPSTREAM + u.pathname.slice(8) + (u.search || '');
      const r = await cachedFetch(wxCache, upstream, WX_TTL);
      log('WX  ', r.cached ? (r.stale ? 'STALE' : 'CACHE') : 'LIVE ', upstream);
      return send(res, r.status, r.type, r.body);
    }

    // ---- 4-b) 기상청 초단기실황 프록시 (국내 발사장 날씨, 10분 캐시) ----
    //   앱은 /kma?lat=..&lon=.. 만 부르고, 서버가 격자변환·base시각·서비스키를 붙여 호출.
    //   기상청 온도(T1H)·풍속(WSD)·강수(RN1)·강수형태(PTY)를 정규화 JSON으로 반환.
    if (u.pathname === '/kma'){
      const lat = parseFloat(u.searchParams.get('lat'));
      const lon = parseFloat(u.searchParams.get('lon'));
      if (!isFinite(lat) || !isFinite(lon)) return send(res, 400, 'application/json; charset=utf-8', JSON.stringify({ error: 'lat/lon 필요' }));
      const { nx, ny } = dfsXyConv(lat, lon);
      const { baseDate, baseTime } = kmaBaseDateTime();
      const upstream = KMA_UPSTREAM + '?serviceKey=' + encodeURIComponent(KMA_SERVICE_KEY)
        + '&pageNo=1&numOfRows=60&dataType=JSON&base_date=' + baseDate + '&base_time=' + baseTime + '&nx=' + nx + '&ny=' + ny;
      const r = await cachedFetch(kmaCache, upstream, KMA_TTL);
      try{
        const j = JSON.parse(r.body.toString('utf8'));
        const h = j.response && j.response.header;
        if (h && h.resultCode === '00'){
          const items = (j.response.body && j.response.body.items && j.response.body.items.item) || [];
          const get = c => { const it = items.find(x => x.category === c); return it ? it.obsrValue : null; };
          const out = { temp: parseFloat(get('T1H')), wind: parseFloat(get('WSD')), precip: parseFloat(get('RN1')), pty: parseInt(get('PTY'), 10), nx, ny };
          log('KMA ', r.cached ? (r.stale ? 'STALE' : 'CACHE') : 'LIVE ', 'nx=' + nx + ' ny=' + ny + ' T1H=' + out.temp);
          return send(res, 200, 'application/json; charset=utf-8', JSON.stringify(out));
        }
        log('KMA ERR', (h && h.resultMsg) || 'unknown');
        return send(res, 502, 'application/json; charset=utf-8', JSON.stringify({ error: (h && h.resultMsg) || 'kma error' }));
      }catch(e){
        log('KMA PARSE ERR', e.message);
        return send(res, 502, 'application/json; charset=utf-8', JSON.stringify({ error: 'kma parse' }));
      }
    }

    // ---- 4-c) 자동 회귀 테스트 러너 (로컬 개발용) ----
    //   test.html 을 앱과 같은 오리진으로 서빙해야 iframe에서 앱 전역함수/DOM에 접근할 수 있음
    //   (file:// 로 열면 Chromium이 교차 파일 접근을 막아 테스트가 동작하지 않음).
    if (u.pathname === '/test_Rev0.html' || u.pathname === '/test'){
      const fpath = path.join(__dirname, 'test_Rev0.html');
      if (fs.existsSync(fpath)){
        return send(res, 200, 'text/html; charset=utf-8', fs.readFileSync(fpath), { 'Cache-Control': 'no-cache' });
      }
    }

    // ---- 5) PWA·공유 정적 파일 (매니페스트·아이콘·og 미리보기 이미지) ----
    const STATIC = {
      '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json; charset=utf-8'],
      '/icon.svg':             ['icon.svg',             'image/svg+xml; charset=utf-8'],
      '/rocket-preview.png':   ['rocket-preview.png',   'image/png'],   // og:image (SNS 공유 카드)
    };
    if (STATIC[u.pathname]){
      const [fname, type] = STATIC[u.pathname];
      const fpath = path.join(__dirname, fname);
      if (fs.existsSync(fpath)){
        return send(res, 200, type, fs.readFileSync(fpath), { 'Cache-Control': 'public, max-age=86400' });
      }
    }

    send(res, 404, 'text/plain; charset=utf-8', 'Not Found');
  }catch(err){
    log('ERR ', req.url, err.message);
    send(res, 502, 'text/plain; charset=utf-8', 'Upstream error: ' + err.message);
  }
});

server.listen(PORT, () => {
  log(`로켓 발사 지도 프록시 시작: http://localhost:${PORT}`);
  log(`  HTML : ${HTML_FILE}`);
  log(`  API  : ${API_UPSTREAM} (캐시 ${API_TTL/60000}분)`);
  log(`  TILES: ${TILE_UPSTREAM} (캐시 ${TILE_TTL/86400000}일)`);
  log(`  WX   : ${WX_UPSTREAM} (캐시 ${WX_TTL/60000}분)`);
  log(`  KMA  : ${KMA_UPSTREAM} (캐시 ${KMA_TTL/60000}분, 키 ${KMA_SERVICE_KEY ? '설정됨' : '없음'})`);
  if (TILE_UPSTREAM.includes('openstreetmap.org')){
    log('  ⚠️  OSM 공개 타일은 개발·데모 전용입니다. 상업 서비스 전 TILE_UPSTREAM을 유료 공급자로 교체하세요.');
  }
});
