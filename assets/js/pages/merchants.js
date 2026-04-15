// /assets/js/pages/merchants.js
// 가맹점 지도 + 보물찾기 시스템

import { auth, db, functions } from '/assets/js/firebase-init.js';
import { collection, getDocs, doc, getDoc, query, where, orderBy, limit,
         setDoc, deleteDoc, serverTimestamp }
                          from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js';
import { onAuthStateChanged }
                          from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js';
import { httpsCallable }
                          from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-functions.js';
import { initBattle, loadBattleData, loadDecorations, loadPlayerState,
         startBattleLoop, startWatchPosition, startSharedSync,
         enterAdminPlaceMode, exitAdminPlaceMode, toggleTowerRanges,
         healHp, healMp, playSound, showFloat,
         castLightning, castIceFreeze, castFireStorm,
         setGsSkillCallback,
         useReviveTicket, updateSkillBar, getPlayerGold, getPlayerLevel, isPlayerDead,
         syncHpFromServer, syncDeathFromServer, syncReviveFromServer,
         spawnGsDrop, removeGsDrop,
         equipWeapon, equipArmor, getTotalAtk, getDefense,
         getEquippedWeapon, getEquippedArmor }
  from './merchants.battle.js';
import { initGameServer, connectToGameServer, disconnectFromGameServer,
         isGameServerConnected, sendPlayerLocation,
         sendPlayerAttack, sendPlayerRevive, sendPlayerSkill, sendDropCollect,
         gsAdminDeleteSpawn, gsAdminKillMonster }
  from './merchants.gameserver.js';
import { hasSpriteConfig, createMonsterSpriteOverlay, preloadSpriteImages }
  from './merchants.monster-sprite.js';

// 스프라이트 이미지 즉시 프리로드 (몬스터 등장 전 브라우저 캐시 확보)
preloadSpriteImages();

// GS 몬스터에 스킬 데미지 전달 — battle.js 스킬 발동 시 호출됨
setGsSkillCallback((skillId, centerLat, centerLng, rangeM) => {
  if (!isGameServerConnected()) return;
  for (const [monsterId, m] of Object.entries(_gsMonsters)) {
    if (!m || m.state === 'dead' || m.state === 'respawning') continue;
    const lat = m.currentLat ?? m.lat;
    const lng = m.currentLng ?? m.lng;
    if (!lat || !lng) continue;
    const dist = Math.sqrt(
      Math.pow((lat - centerLat) * 111320, 2) +
      Math.pow((lng - centerLng) * 111320 * Math.cos(centerLat * Math.PI / 180), 2)
    );
    if (dist <= rangeM) sendPlayerSkill(skillId, monsterId);
  }
});

const $ = id => document.getElementById(id);

// ── 상태 ────────────────────────────────────────────────────────────────────
let allMerchants    = [];
let allPlaces       = [];     // places 컬렉션
let map             = null;
let infoWindow      = null;
let markers         = [];
let placeMarkers    = [];
let treasureBoxes   = [];     // [{id, lat, lng, startHour, endHour, itemPool, active, name}]
let boxMarkers      = [];
let _uid            = null;   // 로그인 유저 UID
let _userEmail      = null;   // 로그인 유저 이메일
let _isAdmin        = false;  // 관리자 여부
let _inventory      = {};     // {itemId: count}
let _boxInventory   = [];     // [{boxId, boxName, collectedAt}]  미개봉 박스
let _items          = {};     // {itemId: {name, image, description}}
let _vouchers          = [];
let _purchasedVouchers = new Set(); // 이미 구매 완료된 voucherId
let _collectedBoxes = new Set(); // 이 세션에서 이미 수집한 box ID
let _boxHpState     = {};        // {boxId: {current, max}} 클라이언트 HP 추적
let _boxAtkCd       = {};        // {boxId: true} 공격 쿨다운
let _nearbyMarkers  = {};        // {uid: Marker} 주변 유저 마커
let _nearbyTimer    = null;      // setInterval handle (10초 폴링)
let _locWriteTs     = 0;         // 마지막 위치 기록 시각 (ms)
let _gsMonsters     = {};        // {monsterId: MonsterInstance} 게임 서버 몬스터
let _gsMarkers      = {};        // {monsterId: Marker} 게임 서버 몬스터 마커 (비-스프라이트)
let _gsOverlays     = {};        // {monsterId: MonsterSpriteOverlay} 스프라이트 오버레이 (dragon 등)

// ── 공유 컨텍스트 (battle 모듈과 공유) ───────────────────────────────────────
const _ctx = {
  map:                 null,   // initMap() 후 설정
  infoWindow:          null,   // initMap() 후 설정
  db,
  functions,
  uid:                 null,   // auth 후 설정
  isAdmin:             false,
  myLocationMarker:    null,   // battle이 쓰고 core가 읽음
  myLocationAccCircle: null,
  locationWatchId:     null,
  totalDist:           0,
  lastDistPos:         null,
  lastHeading:         null,
  lastSpeedPos:        null,
  lastPos:             null,
};

// ── 유틸 ────────────────────────────────────────────────────────────────────
function escHtml(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function parseLatLng(gmapUrl) {
  if (!gmapUrl) return null;
  try {
    const m1 = gmapUrl.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
    if (m1) return { lat: parseFloat(m1[1]), lng: parseFloat(m1[2]) };
    const url = new URL(gmapUrl);
    const q   = url.searchParams.get('q');
    if (q) {
      const m2 = q.match(/^(-?\d+\.\d+),(-?\d+\.\d+)$/);
      if (m2) return { lat: parseFloat(m2[1]), lng: parseFloat(m2[2]) };
    }
  } catch { /* ignore */ }
  return null;
}

function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function nowVietnamHour() {
  return (new Date().getUTCHours() + 7) % 24;
}

function isBoxActive(box) {
  if (!box.active) return false;
  const h = nowVietnamHour();
  const s = box.startHour ?? 0, e = box.endHour ?? 24;
  return s <= e ? (h >= s && h < e) : (h >= s || h < e);
}

// ── Google Maps 로드 ─────────────────────────────────────────────────────────
function loadMapsScript() {
  return new Promise((resolve, reject) => {
    if (window.google?.maps) return resolve();
    window.__merchantMapCb = resolve;
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${window.__mapsKey || ''}&callback=__merchantMapCb&language=ko&region=KR`;
    s.async = true;
    s.onerror = () => reject(new Error('Google Maps 로드 실패'));
    document.head.appendChild(s);
  });
}

// ── 지도 초기화 ──────────────────────────────────────────────────────────────
function initMap() {
  map = new google.maps.Map($('merchantMap'), {
    center: { lat: 20.9947, lng: 105.9487 },
    zoom: 13,
    mapTypeControl: false,
    streetViewControl: false,
    fullscreenControl: false,
    gestureHandling: 'greedy',
    styles: [
      { featureType: 'poi',   elementType: 'all', stylers: [{ visibility: 'off' }] },
      { featureType: 'transit', elementType: 'all', stylers: [{ visibility: 'off' }] },
    ],
  });
  infoWindow = new google.maps.InfoWindow();

  // ctx에도 반영
  _ctx.map = map;
  _ctx.infoWindow = infoWindow;

  // HUD 버튼을 Google Maps Custom Control로 등록 (전체화면·확대 시에도 유지)
  const existingHud = $('mapHud');
  if (existingHud) map.controls[google.maps.ControlPosition.RIGHT_BOTTOM].push(existingHud);

  // 전투 HUD (LEFT_TOP)
  const combatHud = $('combatHud');
  if (combatHud) map.controls[google.maps.ControlPosition.LEFT_TOP].push(combatHud);

  // 스킬바 (BOTTOM_CENTER)
  const skillBar = $('skillBar');
  if (skillBar) map.controls[google.maps.ControlPosition.BOTTOM_CENTER].push(skillBar);

  // 관리자 전투 패널 (LEFT_BOTTOM)
  const adminBattlePanel = $('adminBattlePanel');
  if (adminBattlePanel) map.controls[google.maps.ControlPosition.LEFT_BOTTOM].push(adminBattlePanel);

  // 전체화면 진입/종료 시 position:fixed 모달들을 fullscreen 요소 안으로 이동
  // (HUD·스킬바는 Google Maps Control이므로 자동으로 fullscreen에 포함됨)
  const FS_MODALS = ['invModal', 'itemReveal', 'collectToast', 'criticalToast', 'skillTargetModal'];
  document.addEventListener('fullscreenchange', () => {
    const fs = document.fullscreenElement;
    const dest = fs || document.body;
    FS_MODALS.forEach(id => {
      const el = document.getElementById(id);
      if (el) dest.appendChild(el);
    });
    // battleOverlay: 전체화면 시 merchantMap 안으로, 종료 시 mc-map-wrap 안으로 복귀
    const bo = document.getElementById('battleOverlay');
    if (bo) {
      if (fs) fs.appendChild(bo);
      else document.querySelector('.mc-map-wrap')?.appendChild(bo);
    }
  });
}

// ── 공유 bounds (가맹점 + 보물박스 합산) ─────────────────────────────────────
let _sharedBounds = null;

function fitMapToAllMarkers() {
  if (!map || !_sharedBounds || _sharedBounds.isEmpty()) return;
  const count = markers.length + boxMarkers.length;
  if (count === 1) {
    const pt = _sharedBounds.getCenter();
    map.setCenter(pt); map.setZoom(16);
  } else {
    map.fitBounds(_sharedBounds);
  }
}

// ── 장소 마커 색상 (index.html 동기화) ───────────────────────────────────────
const PLACE_TYPE_COLOR = {
  hospital: '#ef4444', school: '#16a34a', park: '#22c55e',
  shopping: '#ec4899', restaurant: '#f97316', cafe: '#a16207',
};
function placeColor(type) {
  return PLACE_TYPE_COLOR[String(type).toLowerCase()] || '#6b7280';
}

// ── 장소 마커 렌더링 ──────────────────────────────────────────────────────────
function renderPlaceMarkers() {
  placeMarkers.forEach(m => m.setMap(null));
  placeMarkers = [];
  if (!map) return;
  if (!_sharedBounds) _sharedBounds = new google.maps.LatLngBounds();

  allPlaces.forEach(p => {
    let latLng = null;
    if (typeof p.lat === 'number' && typeof p.lng === 'number') latLng = { lat: p.lat, lng: p.lng };
    else latLng = parseLatLng(p.gmap);
    if (!latLng) return;

    const marker = new google.maps.Marker({
      position: latLng, map,
      title: p.name || '',
      icon: {
        path: google.maps.SymbolPath.CIRCLE,
        fillColor: placeColor(p.type),
        fillOpacity: 1,
        strokeColor: '#fff',
        strokeWeight: 2,
        scale: 9,
      },
      zIndex: 1,
    });

    marker.addListener('click', () => {
      infoWindow.setContent(`
        <div style="max-width:240px;font-size:13px;line-height:1.5;">
          <div style="font-weight:700;font-size:14px;margin-bottom:4px;">${escHtml(p.name||'')}</div>
          ${p.type    ? `<div style="color:#7c3aed;margin-bottom:2px;">${escHtml(p.type)}</div>` : ''}
          ${p.area    ? `<div style="color:#6b7280;">구역: ${escHtml(p.area)}</div>` : ''}
          ${p.address ? `<div style="color:#374151;">${escHtml(p.address)}</div>` : ''}
          ${p.phone   ? `<div style="color:#374151;">📞 ${escHtml(p.phone)}</div>` : ''}
          ${p.note    ? `<div style="color:#6b7280;margin-top:4px;">${escHtml(p.note)}</div>` : ''}
          ${p.gmap    ? `<a href="${escHtml(p.gmap)}" target="_blank" rel="noopener"
             style="display:inline-block;margin-top:6px;color:#2563eb;font-size:12px;">구글 지도에서 보기 →</a>` : ''}
        </div>`);
      infoWindow.open(map, marker);
    });

    placeMarkers.push(marker);
    _sharedBounds.extend(latLng);
  });
}

// ── 가맹점 마커 렌더링 ───────────────────────────────────────────────────────
function renderMarkers(list) {
  markers.forEach(m => m.setMap(null));
  markers = [];
  if (!map) return;
  if (!_sharedBounds) _sharedBounds = new google.maps.LatLngBounds();

  list.forEach(m => {
    if (!m._latLng) return;
    const marker = new google.maps.Marker({
      position: m._latLng, map,
      title: m.name || '',
      icon: { url: m.imageUrl || '/assets/images/jump/favicon.png',
        scaledSize: new google.maps.Size(36, 36), anchor: new google.maps.Point(18, 18) },
      zIndex: 10,
    });
    marker.addListener('click', () => {
      infoWindow.setContent(`
        <div style="max-width:240px;font-size:13px;line-height:1.6;">
          ${m.imageUrl ? `<img src="${escHtml(m.imageUrl)}" alt="" style="width:100%;max-height:120px;object-fit:cover;border-radius:6px;margin-bottom:6px;">` : ''}
          <div style="font-weight:700;font-size:14px;margin-bottom:4px;">🏪 ${escHtml(m.name)}</div>
          ${m.career ? `<div style="color:#f59e0b;font-size:12px;">${escHtml(m.career)}</div>` : ''}
          ${m.region ? `<div style="color:#6b7280;">📍 ${escHtml(m.region)}</div>` : ''}
          ${m.phone  ? `<div style="color:#374151;">📞 ${escHtml(m.phone)}</div>` : ''}
          ${m.description ? `<div style="color:#6b7280;margin-top:4px;">${escHtml(m.description)}</div>` : ''}
          ${m.gmap ? `<a href="${escHtml(m.gmap)}" target="_blank" rel="noopener"
             style="display:inline-block;margin-top:6px;color:#2563eb;font-size:12px;">구글 지도에서 보기 →</a>` : ''}
        </div>`);
      infoWindow.open(map, marker);
      document.querySelectorAll('.mc-card').forEach(el => el.style.borderColor = '');
      const card = document.querySelector(`.mc-card[data-id="${m.id}"]`);
      if (card) { card.style.borderColor = '#f59e0b'; card.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
    });
    markers.push(marker);
    _sharedBounds.extend(m._latLng);
    m._marker = marker;
  });
}

// ── 보물박스 HP 초기화 ────────────────────────────────────────────────────────
function getBoxHpState(box) {
  if (!_boxHpState[box.id]) {
    const max = Math.max(1, box.hp || 300);
    _boxHpState[box.id] = { current: max, max };
  }
  return _boxHpState[box.id];
}

// ── 보물박스 정보 InfoWindow ──────────────────────────────────────────────────
function showBoxInfo(box, marker, dist) {
  const h = `${String(box.startHour ?? 0).padStart(2,'0')}:00~${String(box.endHour ?? 24).padStart(2,'0')}:00`;
  const active = isBoxActive(box);
  const st = getBoxHpState(box);
  const hpPct = Math.max(0, (st.current / st.max) * 100);
  const hpColor = hpPct > 50 ? '#22c55e' : hpPct > 25 ? '#f59e0b' : '#ef4444';
  const isAdminNow = _isAdmin || (_userEmail === 'daguri75@gmail.com');
  const alreadyCollected = _collectedBoxes.has(box.id);

  const adminBtn = isAdminNow && !alreadyCollected
    ? `<button onclick="window.__adminCollect('${box.id}')" style="
        margin-top:8px;background:#5c3a1e;color:#ffd700;border:1px solid #7a5c3a;
        padding:4px 12px;border-radius:6px;font-size:12px;font-weight:700;cursor:pointer;">
        🔑 관리자 수집
      </button>` : '';

  infoWindow.setContent(`
    <div style="font-size:13px;line-height:1.7;min-width:190px;">
      <div style="font-weight:700;font-size:14px;margin-bottom:4px;">🎁 ${escHtml(box.name||'보물박스')}</div>
      <div style="color:#888;font-size:12px;">등장: ${h}</div>
      <div style="color:${active?'#16a34a':'#dc2626'};font-weight:600;">${active?'✅ 활성':'⏰ 비활성'}</div>
      ${active && !alreadyCollected ? `
        <div style="margin:6px 0 3px;display:flex;align-items:center;gap:6px;">
          <span style="font-size:11px;color:#888;min-width:20px;">HP</span>
          <div style="flex:1;height:8px;background:#e5e7eb;border-radius:4px;overflow:hidden;">
            <div style="height:100%;width:${hpPct}%;background:${hpColor};border-radius:4px;transition:width .3s;"></div>
          </div>
          <span style="font-size:11px;color:#374151;">${st.current}/${st.max}</span>
        </div>
        <div style="font-size:11px;color:#555;">
          ${dist !== undefined ? `거리 ${Math.round(dist)}m — ` : ''}20m 이내 접근 후 클릭하여 공격!
        </div>` : ''}
      ${alreadyCollected ? '<div style="font-size:11px;color:#aaa;margin-top:4px;">✓ 이미 수집됨</div>' : ''}
      ${adminBtn}
    </div>`);
  infoWindow.open(map, marker);
}

// ── 보물박스 공격 ─────────────────────────────────────────────────────────────
function attackBox(box, marker) {
  if (isPlayerDead()) return; // 사망 시 공격 불가
  if (_boxAtkCd[box.id]) return;
  _boxAtkCd[box.id] = true;
  setTimeout(() => delete _boxAtkCd[box.id], 800);

  const st = getBoxHpState(box);
  if (st.current <= 0) { tryCollect(box); return; }

  const isCrit = Math.random() < 0.1;
  const base = 30 + Math.floor(Math.random() * 21); // 30-50
  const dmg = isCrit ? base * 2 : base;
  st.current = Math.max(0, st.current - dmg);
  playSound(isCrit ? 'critical_hit' : 'box_hit');

  // Firestore 공유 상태 기록 (다른 유저들이 HP 동기화)
  setDoc(doc(db, 'battle_hp', `box_${box.id}`), {
    hp: st.current, maxHp: st.max, type: 'box',
    isDead: st.current <= 0,
    ...(st.current <= 0 ? { deadAt: serverTimestamp() } : {}),
  }, { merge: true }).catch(() => {});

  if (st.current <= 0) {
    // 박스 파괴!
    marker.setIcon({ url:'/assets/images/item/box.png',
      scaledSize: new google.maps.Size(34,34), anchor: new google.maps.Point(17,17) });
    playSound('gold_drop');
    infoWindow.close();
    tryCollect(box);
    return;
  }

  const hpPct = (st.current / st.max) * 100;
  const hpColor = hpPct > 50 ? '#22c55e' : hpPct > 25 ? '#f59e0b' : '#ef4444';
  infoWindow.setContent(`
    <div style="font-size:13px;line-height:1.6;min-width:190px;">
      <div style="font-weight:700;font-size:14px;margin-bottom:6px;">🎁 ${escHtml(box.name||'보물박스')}</div>
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;">
        <span style="font-size:11px;color:#888;min-width:20px;">HP</span>
        <div style="flex:1;height:10px;background:#e5e7eb;border-radius:5px;overflow:hidden;">
          <div style="height:100%;width:${hpPct}%;background:${hpColor};border-radius:5px;transition:width .3s;"></div>
        </div>
        <span style="font-size:11px;color:#374151;min-width:60px;text-align:right;">${st.current}/${st.max}</span>
      </div>
      <div style="color:${isCrit?'#f97316':'#ef4444'};font-weight:700;font-size:13px;">${isCrit?'💥 CRITICAL! ':'💥 '}-${dmg}</div>
      <div style="font-size:11px;color:#555;margin-top:4px;">계속 클릭하여 공격!</div>
    </div>`);
  infoWindow.open(map, marker);
}

// ── 보물박스 마커 렌더링 ──────────────────────────────────────────────────────
function renderBoxMarkers() {
  boxMarkers.forEach(m => m.setMap(null));
  boxMarkers = [];
  if (!map) return;
  if (!isGameServerConnected()) return; // 서버 연결 시에만 보물박스 표시
  if (!_sharedBounds) _sharedBounds = new google.maps.LatLngBounds();

  treasureBoxes.forEach(box => {
    const lat = Number(box.lat), lng = Number(box.lng);
    if (!lat || !lng) return;
    const active = isBoxActive(box);
    // HP 상태 미리 초기화
    getBoxHpState(box);

    const marker = new google.maps.Marker({
      position: { lat, lng }, map,
      title: box.name || '보물박스',
      icon: {
        url: '/assets/images/item/box.png',
        scaledSize: new google.maps.Size(20, 20),
        anchor: new google.maps.Point(10, 10),
      },
      opacity: active ? 1 : 0.35,
      zIndex: 20,
    });

    marker.addListener('click', () => {
      if (_collectedBoxes.has(box.id)) {
        infoWindow.setContent('<div style="font-size:13px;color:#888;padding:4px;">✓ 이미 수집한 보물박스입니다.</div>');
        infoWindow.open(map, marker);
        return;
      }
      if (!isBoxActive(box)) { showBoxInfo(box, marker); return; }
      if (!_uid) {
        infoWindow.setContent('<div style="font-size:13px;padding:4px;">로그인이 필요합니다.</div>');
        infoWindow.open(map, marker);
        return;
      }
      const myLat = _ctx.lastPos?.lat;
      const myLng = _ctx.lastPos?.lng;
      if (!myLat || !myLng) { showBoxInfo(box, marker); return; }

      const dist = haversine(myLat, myLng, lat, lng);
      if (dist > 20) { showBoxInfo(box, marker, dist); return; }

      // 20m 이내 → 공격!
      attackBox(box, marker);
    });

    boxMarkers.push(marker);
    box._marker = marker;
    _sharedBounds.extend({ lat, lng });
  });
}

// ── 카드 렌더링 ──────────────────────────────────────────────────────────────
function renderCards(list) {
  const grid = $('mcGrid');
  if (!list.length) { grid.innerHTML = '<p class="mc-state">등록된 가맹점이 없습니다.</p>'; $('mcCount').textContent = ''; return; }
  $('mcCount').textContent = `${list.length}개`;
  grid.innerHTML = '';
  list.forEach(m => {
    const el = document.createElement('div');
    el.className = 'mc-card';
    el.dataset.id = m.id;
    el.innerHTML = `
      <div class="mc-card-name">${escHtml(m.name||'(이름없음)')}${m._latLng?'<span class="mc-badge-map">지도</span>':''}</div>
      ${m.career  ? `<div class="mc-card-career">${escHtml(m.career)}</div>` : ''}
      ${m.region  ? `<div class="mc-card-region">📍 ${escHtml(m.region)}</div>` : ''}
      ${m.phone   ? `<div class="mc-card-phone">📞 ${escHtml(m.phone)}</div>` : ''}
      ${m.description ? `<div class="mc-card-desc">${escHtml(m.description)}</div>` : ''}
      ${m._latLng
        ? `<a class="mc-card-gmap" href="${escHtml(m.gmap||'')}" target="_blank" rel="noopener">구글 지도에서 보기 →</a>`
        : '<div class="mc-card-no-map">지도 미등록</div>'}`;
    if (m._latLng) {
      el.addEventListener('click', e => {
        if (e.target.tagName === 'A') return;
        map?.panTo(m._latLng); map?.setZoom(17);
        if (m._marker) google.maps.event.trigger(m._marker, 'click');
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    }
    grid.appendChild(el);
  });
}

// ── 검색 필터 ────────────────────────────────────────────────────────────────
function applyFilters() {
  const q = $('mcSearch').value.trim().toLowerCase();
  const countryFilter = $('mcCountry').value || "";
  const regionFilter = $('mcRegion').value || "";
  const categoryFilter = $('mcCategory').value || "";

  const filtered = allMerchants.filter(m => {
    // 검색어 필터
    if (q) {
      const matchesSearch = [m.name, m.career, m.region, m.description].some(v =>
        (v||'').toLowerCase().includes(q)
      );
      if (!matchesSearch) return false;
    }

    // 국가 필터
    if (countryFilter) {
      const merchantRegion = String(m.region || "").toLowerCase();
      let detectedCountry = "";
      if (merchantRegion.includes("베트남") || merchantRegion.includes("vietnam")) detectedCountry = "vietnam";
      else if (merchantRegion.includes("한국") || merchantRegion.includes("korea")) detectedCountry = "korea";
      else detectedCountry = "other";

      if (countryFilter !== detectedCountry) return false;
    }

    // 지역 필터
    if (regionFilter) {
      const merchantRegion = String(m.region || "").toLowerCase();
      if (regionFilter === "oceanpark1" && !merchantRegion.includes("그린1") && !merchantRegion.includes("oceanpark1")) return false;
      if (regionFilter === "oceanpark2" && !merchantRegion.includes("그린2") && !merchantRegion.includes("oceanpark2")) return false;
      if (regionFilter === "oceanpark3" && !merchantRegion.includes("그린3") && !merchantRegion.includes("oceanpark3")) return false;
      if (regionFilter === "other") {
        const hasOceanPark = merchantRegion.includes("그린") || merchantRegion.includes("oceanpark");
        if (hasOceanPark) return false;
      }
    }

    // 업종 필터
    if (categoryFilter) {
      const merchantCareer = String(m.career || "").toLowerCase();
      if (categoryFilter === "restaurant" && !merchantCareer.includes("음식") && !merchantCareer.includes("식당") && !merchantCareer.includes("restaurant")) return false;
      if (categoryFilter === "cafe" && !merchantCareer.includes("카페") && !merchantCareer.includes("cafe")) return false;
      if (categoryFilter === "shopping" && !merchantCareer.includes("쇼핑") && !merchantCareer.includes("상점") && !merchantCareer.includes("shopping")) return false;
      if (categoryFilter === "hotel" && !merchantCareer.includes("숙박") && !merchantCareer.includes("호텔") && !merchantCareer.includes("hotel")) return false;
      if (categoryFilter === "entertainment" && !merchantCareer.includes("엔터") && !merchantCareer.includes("놀이") && !merchantCareer.includes("entertainment")) return false;
      if (categoryFilter === "service" && !merchantCareer.includes("서비스") && !merchantCareer.includes("service")) return false;
      if (categoryFilter === "other") {
        const commonCategories = ["음식", "카페", "쇼핑", "숙박", "엔터", "서비스", "restaurant", "cafe", "shopping", "hotel", "entertainment", "service"];
        if (commonCategories.some(cat => merchantCareer.includes(cat))) return false;
      }
    }

    return true;
  });

  renderCards(filtered);
  renderMarkers(filtered);
}

$('mcSearch').addEventListener('input', applyFilters);
$('mcCountry').addEventListener('change', applyFilters);
$('mcRegion').addEventListener('change', applyFilters);
$('mcCategory').addEventListener('change', applyFilters);

// ── 이동거리 표시 업데이트 ────────────────────────────────────────────────────
function updateDistDisplay() {
  const panel = $('distPanel');
  const el = $('distValue');
  if (!el) return;
  if (panel && !panel.classList.contains('active')) panel.classList.add('active');
  el.textContent = _ctx.totalDist >= 1000
    ? (_ctx.totalDist / 1000).toFixed(2) + ' km'
    : Math.round(_ctx.totalDist) + ' m';
}

// ── 주변 유저 실시간 표시 (100m 이내) ────────────────────────────────────────
const NEARBY_RADIUS_M    = 100;
const LOC_WRITE_INTERVAL = 5000;   // 5초마다 위치 쓰기
const LOC_STALE_MS       = 30000;  // 30초 이상 미업데이트 시 마커 제거
const LOC_POLL_INTERVAL  = 10000;  // 10초마다 근처 유저 폴링

// ── Geohash 인라인 구현 (CDN 불필요) ─────────────────────────────────────────
const _GH32 = '0123456789bcdefghjkmnpqrstuvwxyz';

function _ghEncode(lat, lng, precision) {
  let hash = '', v = 0, bits = 0, even = true;
  let mnLat = -90, mxLat = 90, mnLng = -180, mxLng = 180;
  while (hash.length < precision) {
    const mid = even ? (mnLng + mxLng) / 2 : (mnLat + mxLat) / 2;
    if (even) { if (lng >= mid) { v = v * 2 + 1; mnLng = mid; } else { v *= 2; mxLng = mid; } }
    else       { if (lat >= mid) { v = v * 2 + 1; mnLat = mid; } else { v *= 2; mxLat = mid; } }
    even = !even;
    if (++bits === 5) { hash += _GH32[v]; v = 0; bits = 0; }
  }
  return hash;
}

// precision=7 → 셀 약 150m×120m, 9셀이 450m×360m 커버 → 100m 반경 완전 포함
function _ghCells(lat, lng, precision = 7) {
  const latBits = Math.floor(precision * 5 / 2);
  const lngBits = Math.ceil(precision * 5 / 2);
  const dLat = 180 / Math.pow(2, latBits);   // 셀 높이
  const dLng = 360 / Math.pow(2, lngBits);   // 셀 너비
  const cells = new Set();
  for (const r of [-dLat, 0, dLat]) {
    for (const c of [-dLng, 0, dLng]) {
      const nLat = Math.max(-90, Math.min(90, lat + r));
      const nLng = ((lng + c + 180) % 360) - 180;
      cells.add(_ghEncode(nLat, nLng, precision));
    }
  }
  return [...cells]; // 최대 9개
}

function getNearbyPlayerIcon(name) {
  const initials = (name || '?').slice(0, 2).toUpperCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 36 36">
    <circle cx="18" cy="18" r="17" fill="rgba(59,130,246,0.9)" stroke="#fff" stroke-width="2"/>
    <text x="18" y="23" font-size="12" font-weight="700" fill="#fff" text-anchor="middle">${initials}</text>
  </svg>`;
  return { url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg),
           scaledSize: new google.maps.Size(36,36), anchor: new google.maps.Point(18,18) };
}

// GPS 업데이트 시 호출 — 5초 rate-limit
async function broadcastMyLocation(lat, lng) {
  if (!_uid) return;
  const now = Date.now();
  if (now - _locWriteTs < LOC_WRITE_INTERVAL) return;
  _locWriteTs = now;
  const name = (_userEmail || '').split('@')[0] || '플레이어';
  try {
    await setDoc(doc(db, 'user_locations', _uid), {
      uid: _uid, lat, lng, name,
      geohash7: _ghEncode(lat, lng, 7),
      updatedAt: serverTimestamp(),
    });
  } catch { /* 무시 */ }
}

// 주변 유저 마커 갱신
function updateNearbyMarkers(snap) {
  const myPos = _ctx.lastPos;
  if (!myPos || !map) return;
  const now = Date.now();

  // 기존 마커 중 스냅에 없는 것 제거
  const activeUids = new Set();
  snap.forEach(d => activeUids.add(d.id));
  Object.keys(_nearbyMarkers).forEach(uid => {
    if (!activeUids.has(uid)) { _nearbyMarkers[uid].setMap(null); delete _nearbyMarkers[uid]; }
  });

  snap.forEach(d => {
    const data = d.data();
    if (d.id === _uid) return; // 내 자신 제외
    // 30초 이상 업데이트 없으면 제거
    const ts = data.updatedAt?.toMillis?.() || 0;
    if (now - ts > LOC_STALE_MS) {
      if (_nearbyMarkers[d.id]) { _nearbyMarkers[d.id].setMap(null); delete _nearbyMarkers[d.id]; }
      return;
    }
    const dist = haversine(myPos.lat, myPos.lng, data.lat, data.lng);
    if (dist > NEARBY_RADIUS_M) {
      if (_nearbyMarkers[d.id]) { _nearbyMarkers[d.id].setMap(null); delete _nearbyMarkers[d.id]; }
      return;
    }
    // 마커 생성 or 이동
    if (_nearbyMarkers[d.id]) {
      _nearbyMarkers[d.id].setPosition({ lat: data.lat, lng: data.lng });
      _nearbyMarkers[d.id].setTitle(`👤 ${data.name} (${Math.round(dist)}m)`);
    } else {
      const marker = new google.maps.Marker({
        position: { lat: data.lat, lng: data.lng },
        map,
        title: `👤 ${data.name} (${Math.round(dist)}m)`,
        icon: getNearbyPlayerIcon(data.name),
        zIndex: 80,
      });
      marker.addListener('click', () => {
        infoWindow?.setContent(`
          <div style="font-size:13px;line-height:1.7;">
            <b>👤 ${escHtml(data.name)}</b>
            <div style="font-size:11px;color:#888;margin-top:2px;">거리 ${Math.round(dist)}m</div>
          </div>`);
        infoWindow?.open(map, marker);
      });
      _nearbyMarkers[d.id] = marker;
    }
  });
}

// geohash7 기반 근처 유저 폴링 (onSnapshot 전체 컬렉션 → O(n²) 방지)
async function _pollNearbyPlayers() {
  const myPos = _ctx?.lastPos;
  if (!myPos || !map || !_uid) return;
  const cells = _ghCells(myPos.lat, myPos.lng, 7);
  try {
    const snap = await getDocs(query(
      collection(db, 'user_locations'),
      where('geohash7', 'in', cells)
    ));
    updateNearbyMarkers(snap);
  } catch { /* 무시 */ }
}

// ── 게임 서버 몬스터 마커 ─────────────────────────────────────────────────────
const GS_MONSTER_ATTACK_RANGE_M = 20;

// ── 게임 서버 몬스터 — SVG 마커 아이콘 (비-스프라이트 타입용) ─────────────────
function _gsMonsterIcon(state, hpPct) {
  const dead  = state === 'dead' || state === 'respawning';
  const color = dead ? '#6b7280' : hpPct > 0.5 ? '#ef4444' : hpPct > 0.2 ? '#f97316' : '#dc2626';
  const emoji = dead ? '💀' : '👾';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 36 36">
    <circle cx="18" cy="18" r="17" fill="${color}" stroke="#fff" stroke-width="2" opacity="${dead ? 0.4 : 0.9}"/>
    <text x="18" y="24" font-size="16" text-anchor="middle">${emoji}</text>
  </svg>`;
  return { url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg),
           scaledSize: new google.maps.Size(36, 36), anchor: new google.maps.Point(18, 18) };
}

// ── 게임 서버 몬스터 렌더링 ────────────────────────────────────────────────────
// dragon 등 스프라이트 타입 → MonsterSpriteOverlay
// goblin/orc 등 기타 → SVG Marker

function _renderGsMonster(monster) {
  if (!map) return;
  const { monsterId, type, state, hp, maxHp } = monster;

  // dead 상태 → 렌더링 생략, 기존 오버레이/마커 정리
  if (state === 'dead') {
    if (_gsOverlays[monsterId]) { _gsOverlays[monsterId].setMap(null); delete _gsOverlays[monsterId]; }
    if (_gsMarkers[monsterId])  { _gsMarkers[monsterId].setMap(null);  delete _gsMarkers[monsterId];  }
    delete _gsMonsters[monsterId];
    return;
  }

  // currentLat/Lng (MonsterInstance 필드명)
  const lat = monster.currentLat ?? monster.lat ?? 0;
  const lng = monster.currentLng ?? monster.lng ?? 0;
  // HP 감소 감지 → 피격음
  const prev = _gsMonsters[monsterId];
  if (prev && monster.hp < prev.hp) playSound('arrow_hit');

  _gsMonsters[monsterId] = monster;

  // ── 스프라이트 타입 (dragon 등) ─────────────────────────────────────────────
  if (hasSpriteConfig(type)) {
    if (_gsOverlays[monsterId]) {
      _gsOverlays[monsterId].updateMonster(monster);
    } else {
      _gsOverlays[monsterId] = createMonsterSpriteOverlay(
        map, monster,
        () => {   // 클릭 핸들러 (근접전투)
          const m = _gsMonsters[monsterId];
          if (!m) return;
          if (isPlayerDead()) return;
          if (!isGameServerConnected()) return;
          // 거리 체크 — GS_MONSTER_ATTACK_RANGE_M 이내에서만 공격
          const myPos = _ctx.lastPos;
          if (!myPos) return;
          const mLat = m.currentLat ?? m.lat ?? lat;
          const mLng = m.currentLng ?? m.lng ?? lng;
          const dist = haversine(myPos.lat, myPos.lng, mLat, mLng);
          if (dist > GS_MONSTER_ATTACK_RANGE_M) {
            showFloat(`${Math.round(dist)}m — 접근!`, '#facc15', mLat, mLng);
            return;
          }
          playSound('melee_hit');
          sendPlayerAttack(monsterId);
          showFloat('⚔️', '#f87171', mLat, mLng);
          if (_isAdmin) _showGsMonsterAdminMenu(monsterId, m.spawnId, m.type, null, { lat: mLat, lng: mLng });
        },
        () => {   // 오버레이 제거 완료 콜백
          delete _gsOverlays[monsterId];
          delete _gsMonsters[monsterId];
        },
      );
    }
    return;
  }

  // ── SVG 마커 타입 (goblin, orc 등) ─────────────────────────────────────────
  const hpPct = maxHp > 0 ? hp / maxHp : 1;
  const pos   = { lat, lng };
  const label = `👾 ${type} HP:${hp}/${maxHp}`;

  if (_gsMarkers[monsterId]) {
    _gsMarkers[monsterId].setPosition(pos);
    _gsMarkers[monsterId].setIcon(_gsMonsterIcon(state, hpPct));
    _gsMarkers[monsterId].setTitle(label);
    return;
  }

  const marker = new google.maps.Marker({
    position: pos, map, title: label,
    icon: _gsMonsterIcon(state, hpPct),
    zIndex: 90,
  });
  marker.addListener('click', () => {
    const m = _gsMonsters[monsterId];
    if (isPlayerDead()) return;
    const myPos = _ctx.lastPos;
    if (!myPos) return;
    const mLat = m?.currentLat ?? m?.lat ?? lat;
    const mLng = m?.currentLng ?? m?.lng ?? lng;
    const dist = haversine(myPos.lat, myPos.lng, mLat, mLng);
    if (dist > GS_MONSTER_ATTACK_RANGE_M) {
      infoWindow?.setContent(`<div style="font-size:13px;padding:4px;">👾 ${escHtml(type)}<br><span style="color:#888;font-size:11px;">거리 ${Math.round(dist)}m — ${GS_MONSTER_ATTACK_RANGE_M}m 이내 접근 후 공격</span></div>`);
      infoWindow?.open(map, marker);
      return;
    }
    playSound('melee_hit');
    sendPlayerAttack(monsterId);
    showFloat('⚔️', '#f87171', mLat, mLng);
    infoWindow?.close();
    if (_isAdmin) _showGsMonsterAdminMenu(monsterId, m?.spawnId, type, marker);
  });
  _gsMarkers[monsterId] = marker;
}

// 어드민 전용 — GS 몬스터 클릭 시 infoWindow로 관리 메뉴 표시
function _showGsMonsterAdminMenu(monsterId, spawnId, type, anchor, pos) {
  const shortMid = monsterId.slice(0, 8);
  const shortSid = spawnId ? spawnId.replace('spawn-admin-', '').slice(0, 8) : '?';
  const html = `
    <div style="font-size:12px;padding:4px 2px;min-width:160px">
      <b>🗡 ${escHtml(type)}</b>
      <span style="color:#888;font-size:10px"> #${shortMid}</span><br>
      <span style="color:#9ca3af;font-size:10px">spawn: ${shortSid}</span>
      <div style="display:flex;gap:4px;margin-top:6px;flex-wrap:wrap">
        <button onclick="window.__gsAdminAttackTest('${monsterId}')"
          style="flex:1;min-width:60px;padding:3px 0;background:#3b82f6;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:11px">
          ⚔ 테스트공격
        </button>
        <button onclick="window.__gsAdminKill('${monsterId}')"
          style="flex:1;min-width:60px;padding:3px 0;background:#f97316;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:11px">
          💀 강제사망
        </button>
        <button onclick="window.__gsAdminDelSpawn('${spawnId}')"
          style="flex:1;min-width:60px;padding:3px 0;background:#ef4444;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:11px">
          🗑 스폰삭제
        </button>
      </div>
    </div>`;
  infoWindow?.setContent(html);
  if (anchor) {
    infoWindow?.open(map, anchor);
  } else if (pos) {
    infoWindow?.setPosition(pos);
    infoWindow?.open(map);
  } else {
    infoWindow?.open(map);
  }
}

window.__gsAdminAttackTest = (monsterId) => {
  infoWindow?.close();
  sendPlayerAttack(monsterId);
  console.log('[GS AdminTest] attack →', monsterId.slice(0,8));
};

window.__gsAdminKill = async (monsterId) => {
  try {
    await gsAdminKillMonster(monsterId);
    infoWindow?.close();
  } catch (e) { alert('강제사망 오류: ' + e.message); }
};

window.__gsAdminDelSpawn = async (spawnId) => {
  if (!spawnId || spawnId === 'undefined') { alert('spawnId 없음'); return; }
  if (!confirm(`스폰 [${spawnId}] 삭제?\n해당 스폰의 모든 몬스터가 즉시 제거됩니다.`)) return;
  try {
    const r = await gsAdminDeleteSpawn(spawnId);
    alert(`✅ 삭제 완료 (인스턴스 ${r.instancesRemoved}개 제거)`);
    infoWindow?.close();
  } catch (e) { alert('삭제 오류: ' + e.message); }
};

function _removeGsMonster(monsterId) {
  playSound('monster_die');
  // 스프라이트 오버레이 (dragon 등) — death 애니메이션 후 자체 제거
  if (_gsOverlays[monsterId]) {
    _gsOverlays[monsterId].playDeathAndRemove();
    // _gsOverlays 및 _gsMonsters 정리는 onRemoved 콜백에서 수행
    return;
  }
  // SVG 마커
  if (_gsMarkers[monsterId]) {
    _gsMarkers[monsterId].setMap(null);
    delete _gsMarkers[monsterId];
  }
  delete _gsMonsters[monsterId];
}

function startNearbyPlayers() {
  if (_nearbyTimer) return;
  _pollNearbyPlayers();                                       // 즉시 1회
  _nearbyTimer = setInterval(_pollNearbyPlayers, LOC_POLL_INTERVAL);
  window.addEventListener('beforeunload', cleanupMyLocation);
}

async function cleanupMyLocation() {
  if (!_uid) return;
  try { await deleteDoc(doc(db, 'user_locations', _uid)); } catch { /* 무시 */ }
}

// ── 내 위치 버튼: 첫 클릭 = 게임 시작, 이후 반응 없음 ────────────────────────
let _gameStarted = false;
function showMyLocation() {
  if (_gameStarted) return; // 이미 시작됨 → 무반응
  if (!navigator.geolocation) { alert('이 브라우저는 위치 서비스를 지원하지 않습니다.'); return; }

  const btn = $('btnMyLocation');
  if (btn) btn.textContent = '⏳';

  startWatchPosition();   // GPS 백그라운드 추적 시작
  startBattleLoop();      // 전투 루프 시작
  startNearbyPlayers();   // 주변 유저 실시간 표시
  // 몬스터/타워/박스 HP 공유 동기화
  startSharedSync((boxId, data) => {
    if (!_boxHpState[boxId]) return;
    _boxHpState[boxId].current = data.isDead ? 0 : (data.hp ?? _boxHpState[boxId].current);
  });
  _gameStarted = true;

  if (btn) {
    btn.textContent = '📍';
    btn.title = '게임 진행 중';
  }
}

// ── 보물박스 근접 감지 — 범위 내 마커 강조, HP 있으면 공격해야 수집 ──────────
async function checkProximity(lat, lng) {
  if (!_uid) return;
  broadcastMyLocation(lat, lng); // 내 위치 Firestore에 방송
  sendPlayerLocation(lat, lng, _ctx.lastPos?.accuracy ?? 10); // 게임 서버로 전송
  for (const box of treasureBoxes) {
    if (!box.lat || !box.lng) continue;
    if (!isBoxActive(box)) continue;
    if (_collectedBoxes.has(box.id)) continue;
    const dist = haversine(lat, lng, Number(box.lat), Number(box.lng));
    const maxHp = box.hp || 300;

    if (box._marker) {
      const inRange = dist <= 20;
      // 범위 내: 마커 강조 (크게 + 타이틀 변경)
      box._marker.setIcon({
        url: '/assets/images/item/box.png',
        scaledSize: new google.maps.Size(inRange ? 30 : 20, inRange ? 30 : 20),
        anchor: new google.maps.Point(inRange ? 15 : 10, inRange ? 15 : 10),
      });
      box._marker.setTitle(inRange
        ? `⚔️ ${box.name||'보물박스'} — 클릭하여 공격! (HP ${getBoxHpState(box).current}/${maxHp})`
        : box.name || '보물박스');
    }
  }
}

async function tryCollect(box) {
  if (_collectedBoxes.has(box.id)) return;
  _collectedBoxes.add(box.id); // 동시 중복 호출 방지
  try {
    const pos = await new Promise((res, rej) =>
      navigator.geolocation.getCurrentPosition(res, rej, { enableHighAccuracy: true, timeout: 8000 }));
    const result = await httpsCallable(functions, 'collectTreasureBox')({
      boxId: box.id,
      userLat: pos.coords.latitude,
      userLng: pos.coords.longitude,
    });
    const d = result.data;
    showCollectToast(d.boxName);
    if (!_boxInventory.find(b => b.boxId === box.id)) {
      _boxInventory.push({ boxId: box.id, boxName: d.boxName });
    }
    renderBoxInventory();
  } catch (err) {
    const msg = err.message || '';
    if (msg.includes('이미')) {
      // 영구 수집 완료 → 세션 중 재시도 불필요
    } else if (msg.includes('너무 멀리')) {
      _collectedBoxes.delete(box.id);
    } else {
      _collectedBoxes.delete(box.id);
      console.warn('collect:', msg);
    }
  }
}

// ── 수집 사운드 (Web Audio API) ───────────────────────────────────────────────
function playCollectSound() {
  try {
    const AC = window.AudioContext || /** @type {any} */(window).webkitAudioContext;
    const ctx = new AC();
    const notes = [523.25, 659.25, 783.99, 1046.50]; // C5 E5 G5 C6
    notes.forEach((freq, i) => {
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.value = freq;
      const t = ctx.currentTime + i * 0.12;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.35, t + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
      osc.start(t);
      osc.stop(t + 0.25);
    });
  } catch (_) { /* 사운드 실패는 무시 */ }
}

function showInfoToast(msg) {
  const el = document.createElement('div');
  el.style.cssText = `position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);
    background:rgba(0,0,0,.82);color:#fff;font-size:15px;font-weight:700;
    padding:12px 22px;border-radius:10px;z-index:9999;pointer-events:none;
    text-align:center;white-space:nowrap;`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2500);
}

function showCollectToast(boxName) {
  playCollectSound();
  const el = $('collectToast');
  el.innerHTML = `📦 보물박스 획득!\n<strong>${escHtml(boxName || '보물박스')}</strong>\n인벤토리에서 열어보세요!`;
  el.style.display = 'block';
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.style.display = 'none'; }, 4000);
}

// ── 박스 오픈 사운드 (Web Audio API) ──────────────────────────────────────────
function playOpenBoxSound() {
  try {
    const AC = window.AudioContext || /** @type {any} */(window).webkitAudioContext;
    const ctx = new AC();
    const hits = [
      { freq: 120, type: 'triangle', t: 0,    dur: 0.18, vol: 0.5 },
      { freq: 200, type: 'sine',     t: 0.05, dur: 0.12, vol: 0.3 },
      { freq: 880, type: 'sine',     t: 0.20, dur: 0.15, vol: 0.3 },
      { freq: 1320,type: 'sine',     t: 0.32, dur: 0.18, vol: 0.25 },
      { freq: 1760,type: 'sine',     t: 0.44, dur: 0.22, vol: 0.2 },
    ];
    hits.forEach(({ freq, type, t, dur, vol }) => {
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.type = type; osc.frequency.value = freq;
      const st = ctx.currentTime + t;
      gain.gain.setValueAtTime(0, st);
      gain.gain.linearRampToValueAtTime(vol, st + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, st + dur);
      osc.start(st); osc.stop(st + dur);
    });
  } catch (_) { /* 무시 */ }
}

// ── 관리자: PC에서 GPS 없이 박스 수집 ────────────────────────────────────────
async function adminCollectBox(boxId) {
  if (_collectedBoxes.has(boxId)) { alert('이미 수집한 보물박스입니다.'); return; }
  _collectedBoxes.add(boxId);
  infoWindow.close();
  try {
    const result = await httpsCallable(functions, 'adminCollectTreasureBox')({ boxId });
    const d = result.data;
    showCollectToast(d.boxName);
    if (!_boxInventory.find(b => b.boxId === boxId)) {
      _boxInventory.push({ boxId, boxName: d.boxName });
    }
    renderBoxInventory();
  } catch (err) {
    _collectedBoxes.delete(boxId);
    alert('수집 실패: ' + (err.message || err));
  }
}

// infoWindow 버튼용 전역 핸들러
window.__adminCollect = (boxId) => adminCollectBox(boxId);

// ── 박스 오픈 (인벤토리 박스 클릭) ────────────────────────────────────────────
async function openBox(boxId, slotEl) {
  if (slotEl) slotEl.classList.add('opening');
  try {
    const result = await httpsCallable(functions, 'openTreasureBox')({ boxId });
    const d = result.data;
    // 미개봉 박스 인벤토리에서 제거
    _boxInventory = _boxInventory.filter(b => b.boxId !== boxId);
    renderBoxInventory();
    // 아이템 인벤토리 업데이트
    const iid = String(d.itemId);
    _inventory[iid] = (_inventory[iid] || 0) + 1;
    renderInventory();
    // 오픈 사운드 + 아이템 획득 오버레이
    playOpenBoxSound();
    showItemReveal(d.itemName, d.itemImage, d.itemId);
  } catch (err) {
    if (slotEl) slotEl.classList.remove('opening');
    alert('박스 오픈 실패: ' + (err.message || err));
  }
}

function showItemReveal(itemName, itemImage, itemId) {
  const img = $('itemRevealImg');
  const name = $('itemRevealName');
  if (img) {
    const fallback = itemId ? `/assets/images/item/${escHtml(String(itemId))}.png` : '/assets/images/item/0.png';
    const src = itemImage ? `/assets/images/item/${escHtml(itemImage)}` : fallback;
    img.src = src;
    img.onerror = () => { img.onerror = null; img.src = fallback; };
    img.style.display = '';
  }
  if (name) name.textContent = itemName || '아이템';
  $('itemReveal')?.classList.add('open');
}

// ── 미개봉 보물박스 렌더링 ────────────────────────────────────────────────────
function renderBoxInventory() {
  const el = $('boxInvList');
  if (!el) return;
  if (!_boxInventory.length) {
    el.innerHTML = '<div class="voucher-empty">미개봉 보물박스가 없습니다.</div>';
    return;
  }
  const grid = document.createElement('div');
  grid.className = 'box-inv-grid';
  _boxInventory.forEach(({ boxId, boxName }) => {
    const slot = document.createElement('div');
    slot.className = 'box-inv-slot';
    slot.title = `${boxName || '보물박스'} — 클릭하여 열기`;
    slot.innerHTML = `
      <img src="/assets/images/item/box.png" alt="box" onerror="this.style.display='none'">
      <span class="box-slot-name">${escHtml(boxName || '보물박스')}</span>`;
    slot.addEventListener('click', () => openBox(boxId, slot));
    grid.appendChild(slot);
  });
  el.innerHTML = '';
  el.appendChild(grid);
}

// ── 인벤토리 렌더링 (4×5 = 20 슬롯) ────────────────────────────────────────
function _updateEquipStats() {
  const statsEl = $('invEquipStats');
  if (!statsEl) return;
  const wNum = getEquippedWeapon().replace('weapon_', '');
  statsEl.innerHTML =
    `<span>⚔️ 기본공격력: <b>100</b></span>` +
    `<span>⚔️ 장착무기: <b>+${wNum}</b></span>` +
    `<span>⚔️ 총공격력: <b>${getTotalAtk()}</b></span>` +
    `<span>🛡 방어력: <b>${getDefense()}</b></span>`;
}

function renderInventory() {
  // 장비 능력치는 grid 유무와 무관하게 항상 업데이트
  _updateEquipStats();

  const grid = $('invGrid');
  if (!grid) return;
  const SLOTS = 20;

  // 정렬: potion_red 1순위, revive_ticket 2순위, 나머지 숫자 정렬
  const ITEM_PRIORITY = { potion_red: 0, potion_mp: 1, revive_ticket: 2 };
  const filled = Object.entries(_inventory)
    .filter(([, c]) => c > 0)
    .sort((a, b) => {
      const pa = ITEM_PRIORITY[a[0]] ?? 99;
      const pb = ITEM_PRIORITY[b[0]] ?? 99;
      if (pa !== pb) return pa - pb;
      return Number(a[0]) - Number(b[0]);
    });

  // 스킬바 빨간약 뱃지 업데이트
  const potBadge = $('skillPotionBadge');
  const potBtn   = $('skillBtnPotion');
  if (potBadge) potBadge.textContent = (_inventory['potion_red'] || 0) > 0 ? String(_inventory['potion_red']) : '';
  if (potBtn)   potBtn.disabled = (_inventory['potion_red'] || 0) <= 0;

  grid.innerHTML = '';
  for (let i = 0; i < SLOTS; i++) {
    const slot = document.createElement('div');
    slot.className = 'inv-slot';
    if (i < filled.length) {
      const [itemId, count] = filled[i];
      slot.classList.add('has-item');
      slot.dataset.itemid = itemId;
      if (itemId === 'potion_red') {
        slot.title = '빨간약 — 클릭하여 사용 (HP +100)';
        slot.style.cursor = 'pointer';
        slot.innerHTML = `
          <img src="/assets/images/item/hp.png"
               onerror="this.onerror=null;this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 40 40%22><circle cx=%2220%22 cy=%2220%22 r=%2218%22 fill=%22%23ef4444%22/><text x=%2220%22 y=%2226%22 font-size=%2220%22 text-anchor=%22middle%22>💊</text></svg>'"
               alt="빨간약" />
          <span class="slot-name">빨간약</span>
          <span class="slot-count">${count}</span>`;
        slot.addEventListener('click', usePotion);
      } else if (itemId === 'potion_mp') {
        slot.title = '마법약 — 클릭하여 사용 (MP 전체 회복)';
        slot.style.cursor = 'pointer';
        slot.innerHTML = `
          <img src="/assets/images/item/mp.png"
               onerror="this.onerror=null;this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 40 40%22><circle cx=%2220%22 cy=%2220%22 r=%2218%22 fill=%22%233b82f6%22/><text x=%2220%22 y=%2226%22 font-size=%2220%22 text-anchor=%22middle%22>🔮</text></svg>'"
               alt="마법약" />
          <span class="slot-name">마법약</span>
          <span class="slot-count">${count}</span>`;
        slot.addEventListener('click', useMpPotion);
      } else if (itemId === 'revive_ticket') {
        slot.title = '부활 아이템 — 사망 시 클릭하여 즉시 부활 (HP·MP 50%)';
        slot.style.cursor = 'pointer';
        slot.innerHTML = `
          <img src="/assets/images/item/revive_ticket.png"
               onerror="this.onerror=null;this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 40 40%22><circle cx=%2220%22 cy=%2220%22 r=%2218%22 fill=%22%238b5cf6%22/><text x=%2220%22 y=%2226%22 font-size=%2220%22 text-anchor=%22middle%22>✨</text></svg>'"
               alt="부활 아이템" />
          <span class="slot-name">부활권</span>
          <span class="slot-count">${count}</span>`;
        slot.addEventListener('click', () => { useReviveTicket(); sendPlayerRevive(); });
      } else if (String(itemId).startsWith('weapon_')) {
        // ── 무기 ────────────────────────────────────────────────────────────
        const num = String(itemId).replace('weapon_', '');
        const isEquipped = getEquippedWeapon() === itemId;
        slot.title = `무기 +${num} — 클릭하여 장착`;
        slot.style.cursor = 'pointer';
        if (isEquipped) slot.classList.add('equipped');
        slot.innerHTML = `
          <img src="/assets/images/weapon/${escHtml(num)}.png"
               onerror="this.onerror=null;this.src='/assets/images/item/0.png'"
               alt="무기 +${escHtml(num)}" />
          <span class="slot-name">무기 +${escHtml(num)}</span>
          ${isEquipped ? '<span class="slot-equipped">장착</span>' : `<span class="slot-count">${count}</span>`}`;
        slot.addEventListener('click', () => {
          equipWeapon(itemId);
          renderInventory();
          showInfoToast(`⚔️ 무기 +${num} 장착! 총공격력 ${getTotalAtk()}`);
        });
      } else if (String(itemId).startsWith('armo_')) {
        // ── 방어구 ───────────────────────────────────────────────────────────
        const num = String(itemId).replace(/^armo_\d+_?/, '');
        const defVal = String(itemId).match(/(\d+)$/)?.[1] || num;
        const isEquipped = getEquippedArmor() === itemId;
        const folder = Math.floor(parseInt(defVal) / 10);
        slot.title = `방어구 DEF ${defVal} — 클릭하여 장착`;
        slot.style.cursor = 'pointer';
        if (isEquipped) slot.classList.add('equipped');
        slot.innerHTML = `
          <img src="/assets/images/armo/${escHtml(String(folder))}/${escHtml(defVal)}.png"
               onerror="this.onerror=null;this.src='/assets/images/item/0.png'"
               alt="방어구 DEF ${escHtml(defVal)}" />
          <span class="slot-name">방어 ${escHtml(defVal)}</span>
          ${isEquipped ? '<span class="slot-equipped">장착</span>' : `<span class="slot-count">${count}</span>`}`;
        slot.addEventListener('click', () => {
          equipArmor(itemId);
          renderInventory();
          showInfoToast(`🛡 방어구 DEF ${defVal} 장착!`);
        });
      } else {
        const meta = _items[String(itemId)] || {};
        const imgFile = meta.image || (itemId + '.png');
        const fallbackImg = `/assets/images/item/${escHtml(String(itemId))}.png`;
        slot.innerHTML = `
          <img src="/assets/images/item/${escHtml(imgFile)}"
               onerror="this.onerror=null;this.src='${fallbackImg}'"
               alt="${escHtml(meta.name || itemId)}" />
          <span class="slot-name">${escHtml(meta.name || ('#' + itemId))}</span>
          <span class="slot-count">${count}</span>`;
      }
    } else {
      slot.innerHTML = '<span class="slot-placeholder">□</span>';
    }
    grid.appendChild(slot);
  }
}

async function useMpPotion() {
  if (!_uid) return;
  if ((_inventory['potion_mp'] || 0) <= 0) { alert('마법약이 없습니다.'); return; }
  try {
    const fn = httpsCallable(functions, 'useMpPotion');
    const res = await fn();
    _inventory['potion_mp'] = res.data.remaining;
    // MP 전체 회복은 battle 모듈의 healMp 또는 직접 최대치 설정
    healMp(0); // 0 = 최대치로 전체 회복
    showInfoToast('🔮 마법약 사용! MP 전체 회복');
    playSound('heal');
    renderInventory();
  } catch (err) {
    alert('사용 실패: ' + err.message);
  }
}

async function usePotion() {
  if (!_uid) return;
  const current = _inventory['potion_red'] || 0;
  if (current <= 0) { alert('빨간약이 없습니다.'); return; }

  try {
    const fn = httpsCallable(functions, 'usePotion');
    const res = await fn();
    _inventory['potion_red'] = res.data.remaining;
    healHp(100);
    showInfoToast('💊 빨간약 사용! HP +100');
    playSound('heal');
    renderInventory();
  } catch (err) {
    alert('사용 실패: ' + err.message);
  }
}

// ── 바우처 레시피 렌더링 ─────────────────────────────────────────────────────
function renderVouchers() {
  const el = $('voucherList');
  if (!el) return;
  if (!_vouchers.length) { el.innerHTML = '<div class="voucher-empty">등록된 조합 레시피가 없습니다.</div>'; return; }

  el.innerHTML = _vouchers.map(v => {
    const reqs = (v.requirements || []).map(r => {
      const isGold = r.type === 'gold' || r.itemId === 'coin';
      const have   = isGold ? getPlayerGold() : (_inventory[String(r.itemId)] || 0);
      const label  = isGold ? '💰 코인' : escHtml(_items[String(r.itemId)]?.name || '#' + r.itemId);
      const ok     = have >= r.count;
      return `<span style="color:${ok?'#86efac':'#fca5a5'}">${label} ×${r.count} (보유:${have})</span>`;
    }).join(' + ');
    const canCraft = (v.requirements||[]).every(r => {
      const isGold = r.type === 'gold' || r.itemId === 'coin';
      return isGold ? getPlayerGold() >= r.count : (_inventory[String(r.itemId)]||0) >= r.count;
    });
    return `
      <div class="voucher-row">
        <div class="voucher-name">🎟 ${escHtml(v.name)}</div>
        <div class="voucher-reqs">${reqs}</div>
        <div class="voucher-reward">보상: ${escHtml(v.reward||'바우처 지급')}</div>
        <button class="btn-craft" data-voucher="${escHtml(v.id)}" ${canCraft?'':'disabled'}>
          ${canCraft?'조합하기':'재료 부족'}
        </button>
      </div>`;
  }).join('');

  el.querySelectorAll('.btn-craft:not(:disabled)').forEach(btn => {
    btn.addEventListener('click', async () => {
      const vid = btn.dataset.voucher;
      btn.disabled = true; btn.textContent = '처리 중...';
      try {
        const res = await httpsCallable(functions, 'craftVoucher')({ voucherId: vid });
        const reward = res.data.reward || '';
        // 보상이 무기/방어구면 자동 장착
        if (reward.startsWith('weapon_')) {
          equipWeapon(reward);
          showInfoToast(`⚔️ ${reward} 장착! 총공격력 ${getTotalAtk()}`);
        } else if (reward.startsWith('armo_')) {
          equipArmor(reward);
          showInfoToast(`🛡 ${reward} 장착! 방어력 ${getDefense()}`);
        }
        alert(`✅ 조합 성공!\n${res.data.voucherName}\n보상: ${reward}`);
        await loadInventory();
      } catch (err) {
        alert('조합 실패: ' + (err.message || err));
        btn.disabled = false; btn.textContent = '조합하기';
      }
    });
  });
}

// ── 데이터 로드 ──────────────────────────────────────────────────────────────
async function loadPlaces() {
  const snap = await getDocs(collection(db, 'places'));
  allPlaces = [];
  snap.forEach(d => { if (d.data().visible !== false) allPlaces.push({ id: d.id, ...d.data() }); });
}

async function loadTreasureBoxes() {
  const snap = await getDocs(collection(db, 'treasure_boxes'));
  treasureBoxes = [];
  snap.forEach(d => { if (d.data().active !== false) treasureBoxes.push({ id: d.id, ...d.data() }); });
}

async function loadItems() {
  const snap = await getDocs(collection(db, 'treasure_items'));
  _items = {};
  snap.forEach(d => { _items[d.id] = d.data(); });
}

async function loadVouchers() {
  const snap = await getDocs(collection(db, 'treasure_vouchers'));
  _vouchers = [];
  snap.forEach(d => { if (d.data().active !== false) _vouchers.push({ id: d.id, ...d.data() }); });
}

async function loadInventory() {
  if (!_uid) {
    _inventory = {}; _boxInventory = [];
    renderBoxInventory(); renderInventory(); renderVouchers(); renderMyVouchers([]);
    return;
  }

  const settle = p => p.then(v => ({ ok: true, v })).catch(e => { console.warn('loadInventory query error:', e.message); return { ok: false }; });

  const [invRes, boxRes, vRes, purchaseRes] = await Promise.all([
    settle(getDocs(query(collection(db, 'treasure_inventory'), where('uid', '==', _uid)))),
    settle(getDocs(query(collection(db, 'treasure_inventory_boxes'), where('uid', '==', _uid)))),
    settle(getDocs(query(
      collection(db, 'treasure_voucher_logs'),
      where('uid', '==', _uid),
      orderBy('craftedAt', 'desc'),
      limit(50)
    ))),
    settle(getDocs(query(collection(db, 'treasure_voucher_purchases'), where('uid', '==', _uid)))),
  ]);

  // items 메타데이터가 아직 안 로드됐으면 여기서 로드
  if (!Object.keys(_items).length) await loadItems();

  _inventory = {};
  if (invRes.ok) invRes.v.forEach(d => {
    const r = d.data();
    if (r.count > 0) _inventory[String(r.itemId)] = r.count;
  });

  // 무기/방어구가 하나도 없으면 기본 장비 표시 (클라이언트 전용 — DB 미저장)
  const hasWeapon = Object.keys(_inventory).some(k => k.startsWith('weapon_'));
  const hasArmor  = Object.keys(_inventory).some(k => k.startsWith('armo_'));
  if (!hasWeapon) _inventory['weapon_100'] = (_inventory['weapon_100'] || 0) + 1;
  if (!hasArmor)  _inventory['armo_10']    = (_inventory['armo_10']    || 0) + 1;

  _boxInventory = [];
  if (boxRes.ok) boxRes.v.forEach(d => {
    const r = d.data();
    _boxInventory.push({ boxId: r.boxId, boxName: r.boxName });
    _collectedBoxes.add(r.boxId);
  });

  _purchasedVouchers = new Set();
  if (purchaseRes.ok) purchaseRes.v.forEach(d => _purchasedVouchers.add(d.data().voucherId));

  renderBoxInventory();
  renderInventory();
  renderVouchers();
  renderMyVouchers(vRes.ok ? vRes.v.docs.map(d => d.data()) : []);
  renderExchangeSection();
}

function renderMyVouchers(logs) {
  const el = $('myVoucherList');
  if (!el) return;
  if (!logs.length) { el.innerHTML = '<div class="voucher-empty">보유 바우처가 없습니다.</div>'; return; }

  el.innerHTML = logs.map(r => {
    const ts = r.craftedAt?.toDate?.();
    const dateStr = ts ? ts.toLocaleDateString('ko-KR') : '';
    const imgSrc = r.image ? `/assets/images/vouchers/${escHtml(r.image)}` : '';
    return `
      <div class="voucher-row" style="display:flex;gap:10px;align-items:center;">
        ${imgSrc ? `<img src="${imgSrc}" style="width:44px;height:44px;object-fit:contain;border-radius:6px;background:#1a0e06;" onerror="this.style.display='none'">` : '<div style="width:44px;height:44px;background:#1a0e06;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:22px;">🎟</div>'}
        <div style="flex:1;">
          <div class="voucher-name">${escHtml(r.voucherName || '바우처')}</div>
          <div class="voucher-reward">${escHtml(r.reward || '')}</div>
          ${dateStr ? `<div style="font-size:10px;color:#888;">${dateStr}</div>` : ''}
        </div>
      </div>`;
  }).join('');
}

// ── 상품교환권 섹션 (메인 페이지 노출) ───────────────────────────────────────
function renderExchangeSection() {
  const grid = $('excGrid');
  if (!grid) return;
  if (!_vouchers.length) {
    grid.innerHTML = '<div class="exc-empty">등록된 교환권이 없습니다.</div>';
    return;
  }

  grid.innerHTML = _vouchers.map(v => {
    const reqs = v.requirements || [];

    // 진행률: 요건 중 가장 낮은 충족 비율
    let minRatio = 1;
    const chips = reqs.map(r => {
      const isGold = r.type === 'gold' || r.itemId === 'coin';
      const have   = isGold ? getPlayerGold() : (_inventory[String(r.itemId)] || 0);
      const need   = r.count || 1;
      const ratio  = Math.min(1, have / need);
      if (ratio < minRatio) minRatio = ratio;

      const meta   = isGold ? null : _items[String(r.itemId)];
      const label  = isGold ? '💰 코인' : escHtml(meta?.name || ('#' + r.itemId));
      const imgSrc = (!isGold && meta?.image) ? `/assets/images/item/${escHtml(meta.image)}` : '';
      const cls    = !_uid ? 'no-data' : ratio >= 1 ? 'ok' : 'lack';
      const haveStr = _uid ? ` <small>(${have}/${need})</small>` : '';

      const imgTag = imgSrc
        ? `<img src="${imgSrc}" alt="" onerror="this.style.display='none'">`
        : '';
      return `<span class="exc-req-chip ${cls}">${imgTag}${label}×${need}${haveStr}</span>`;
    }).join('');

    // 코인 조건 칩
    const coinChip = (() => {
      if (!v.minCoins) return '';
      const have  = getPlayerGold();
      const ratio = Math.min(1, have / v.minCoins);
      if (ratio < minRatio) minRatio = ratio;
      const cls   = !_uid ? 'no-data' : ratio >= 1 ? 'ok' : 'lack';
      const haveStr = _uid ? ` <small>(${have}/${v.minCoins})</small>` : '';
      return `<span class="exc-req-chip ${cls}">💰 코인×${v.minCoins}${haveStr}</span>`;
    })();

    // 레벨 조건 칩
    const levelChip = (() => {
      if (!v.minLevel) return '';
      const have  = getPlayerLevel();
      const ok    = have >= v.minLevel;
      if (!ok && minRatio > 0) minRatio = 0;
      const cls   = !_uid ? 'no-data' : ok ? 'ok' : 'lack';
      const haveStr = _uid ? ` <small>(LV.${have})</small>` : '';
      return `<span class="exc-req-chip ${cls}">⭐ LV.${v.minLevel} 이상${haveStr}</span>`;
    })();

    const allChips = chips + coinChip + levelChip;

    const pct    = Math.round(minRatio * 100);
    const canDo  = _uid
      && reqs.every(r => {
           const isGold = r.type === 'gold' || r.itemId === 'coin';
           return isGold ? getPlayerGold() >= r.count : (_inventory[String(r.itemId)] || 0) >= r.count;
         })
      && (!v.minCoins || getPlayerGold()  >= v.minCoins)
      && (!v.minLevel || getPlayerLevel() >= v.minLevel);

    // 이미지 경로 정규화
    const imgUrl = (() => {
      const img = v.image;
      if (!img) return '';
      if (img.startsWith('http') || img.startsWith('/')) return img;
      if (img.includes('/')) return '/' + img;            // "assets/images/..." 형태
      return `/assets/images/vouchers/${img}`;            // 파일명만 있는 경우
    })();

    const alreadyBought = _uid && _purchasedVouchers.has(v.id);
    const btnLabel = !_uid ? '로그인 필요' : alreadyBought ? '✅ 구매 완료' : canDo ? '🎟 지금 교환하기' : '재료 부족';

    return `
      <div class="exc-card">
        ${imgUrl
          ? `<div class="exc-card-img-wrap">
               <img src="${escHtml(imgUrl)}" alt="${escHtml(v.name)}"
                 onerror="this.parentNode.innerHTML='<span class=exc-card-img-fallback>🎟</span>'">
             </div>`
          : `<div class="exc-card-img-wrap">
               <span class="exc-card-img-fallback">🎟</span>
             </div>`
        }
        <div class="exc-card-banner">
          <div class="exc-card-reward">${escHtml(v.reward || '상품교환권')}</div>
          <div class="exc-card-name">${escHtml(v.name)}</div>
        </div>
        <div class="exc-card-body">
          <div>
            <div class="exc-req-label">필요 아이템</div>
            <div class="exc-req-list" style="margin-top:6px;">${allChips || '<span style="color:var(--muted,#9ca3af);font-size:.82rem;">조건 없음</span>'}</div>
          </div>
          ${_uid ? `
          <div class="exc-progress-wrap">
            <div class="exc-progress-bar"><div class="exc-progress-fill" style="width:${pct}%"></div></div>
            <div class="exc-progress-text">진행도 ${pct}%</div>
          </div>` : `<div class="exc-login-hint">로그인 후 보유량을 확인하세요</div>`}
          <button class="btn-exc" data-vid="${escHtml(v.id)}" ${(canDo && !alreadyBought) ? '' : 'disabled'}>${btnLabel}</button>
        </div>
      </div>`;
  }).join('');

  grid.querySelectorAll('.btn-exc:not(:disabled)').forEach(btn => {
    btn.addEventListener('click', async () => {
      const vid = btn.dataset.vid;
      btn.disabled = true; btn.textContent = '처리 중...';
      try {
        const res = await httpsCallable(functions, 'craftVoucher')({ voucherId: vid });
        alert(`✅ 교환 성공!\n${res.data.voucherName}\n보상: ${res.data.reward}`);
        await loadInventory();
        renderExchangeSection();
      } catch (err) {
        alert('교환 실패: ' + (err.message || err));
        btn.disabled = false; btn.textContent = '🎟 지금 교환하기';
      }
    });
  });
}

// ── 인벤토리 모달 ────────────────────────────────────────────────────────────
function openInventory() {
  $('invModal').classList.add('open');
  _updateEquipStats(); // 능력치 즉시 표시 (async 대기 없이)
  loadInventory();     // 최신 데이터로 갱신
}
function closeInventory() { $('invModal').classList.remove('open'); }

// ── 메인 ────────────────────────────────────────────────────────────────────
async function init() {
  // battle 모듈 초기화 (ctx와 callbacks 연결)
  initBattle(_ctx, {
    onCheckProximity: checkProximity,
    onLoadInventory:  loadInventory,
    onUpdateDistDisplay: updateDistDisplay,
  });

  // Auth 리스너 (비동기 — 블로킹 없음)
  onAuthStateChanged(auth, async user => {
    _uid       = user?.uid   || null;
    _userEmail = user?.email || null;
    _ctx.uid   = _uid;
    if (_uid) {
      const snap = await getDoc(doc(db, 'admins', _uid));
      _isAdmin = snap.exists() || (_userEmail === 'daguri75@gmail.com');
      _ctx.isAdmin = _isAdmin;
      // 전투 시스템: 플레이어 상태 로드
      loadPlayerState();
      // 인벤토리 + 교환권 섹션 갱신
      loadInventory();
    } else {
      _isAdmin = false;
      _ctx.isAdmin = false;
    }
    // 관리자 패널 표시
    const abp = $('adminBattlePanel');
    if (abp) abp.classList.toggle('open', !!_isAdmin);
  });

  // ── Phase 1: 지도 표시에 필요한 것만 병렬 로드 ──────────────────────────────
  const settle1 = p => p.catch(() => null);
  const [, merchantSnap] = await Promise.all([
    settle1(loadMapsScript()),
    settle1(getDocs(collection(db, 'merchants'))),
    settle1(loadTreasureBoxes()),
  ]);

  // 가맹점 데이터 파싱
  allMerchants = [];
  merchantSnap?.forEach(d => {
    const m = d.data();
    if (m.active === false) return;
    const latLng = (m.lat && m.lng) ? { lat: m.lat, lng: m.lng } : parseLatLng(m.gmap);
    allMerchants.push({ id: d.id, ...m, _latLng: latLng });
  });
  allMerchants.sort((a, b) => (b._latLng ? 1 : 0) - (a._latLng ? 1 : 0));

  // 지도 + 카드 즉시 표시
  if (window.google?.maps) {
    initMap();
    renderBoxMarkers();
    fitMapToAllMarkers();
  }
  applyFilters();

  // 버튼 이벤트
  $('btnMyLocation')?.addEventListener('click', showMyLocation);
  $('btnInventory')?.addEventListener('click', openInventory);
  $('btnFullscreen')?.addEventListener('click', () => {
    const el = $('merchantMap')?.parentElement ?? $('merchantMap');
    if (!document.fullscreenElement) {
      el?.requestFullscreen?.();
      $('btnFullscreen').textContent = '✕';
    } else {
      document.exitFullscreen?.();
      $('btnFullscreen').textContent = '⛶';
    }
  });
  document.addEventListener('fullscreenchange', () => {
    const btn = $('btnFullscreen');
    if (btn) btn.textContent = document.fullscreenElement ? '✕' : '⛶';
  });
  $('btnResetDist')?.addEventListener('click', () => {
    _ctx.totalDist = 0; _ctx.lastDistPos = null; updateDistDisplay();
  });
  $('btnCloseInv')?.addEventListener('click', closeInventory);
  $('invModal')?.addEventListener('click', e => { if (e.target === $('invModal')) closeInventory(); });
  $('btnRevealClose')?.addEventListener('click', () => $('itemReveal')?.classList.remove('open'));
  $('itemReveal')?.addEventListener('click', e => { if (e.target === $('itemReveal')) $('itemReveal').classList.remove('open'); });

  // 관리자 전투 배치 패널 버튼
  $('btnPlaceMonster')?.addEventListener('click', () => enterAdminPlaceMode('monster'));
  $('btnPlaceDragon')?.addEventListener('click',  () => enterAdminPlaceMode('dragon'));
  $('btnPlaceOrc')?.addEventListener('click',     () => enterAdminPlaceMode('orc'));
  $('btnPlaceOrc2')?.addEventListener('click',    () => enterAdminPlaceMode('orc2'));
  $('btnPlaceOrc3')?.addEventListener('click',    () => enterAdminPlaceMode('orc3'));
  $('btnPlacePirate')?.addEventListener('click',  () => enterAdminPlaceMode('pirate'));
  $('btnPlacePirate2')?.addEventListener('click', () => enterAdminPlaceMode('pirate2'));
  $('btnPlacePirate3')?.addEventListener('click', () => enterAdminPlaceMode('pirate3'));
  $('btnPlaceArcherTower')?.addEventListener('click', () => enterAdminPlaceMode('archer_tower'));
  $('btnPlaceCannonTower')?.addEventListener('click', () => enterAdminPlaceMode('cannon_tower'));
  $('btnPlaceDeco')?.addEventListener('click',    () => enterAdminPlaceMode('deco'));
  $('btnGiveRevive')?.addEventListener('click', async () => {
    const targetUid = prompt('부활권 지급할 UID (비우면 본인):', _uid || '') || _uid;
    if (!targetUid) return;
    const count = parseInt(prompt('지급 수량:', '10000') || '10000');
    if (!count || count < 1) return;
    try {
      const res = await httpsCallable(functions, 'adminGiveRevive')({ targetUid, count });
      alert(`✅ 부활권 ${res.data.given}장 지급 완료`);
      if (targetUid === _uid) await loadInventory();
    } catch (err) { alert('실패: ' + err.message); }
  });

  $('btnGivePotion')?.addEventListener('click', async () => {
    const targetUid = prompt('빨간약 지급할 UID (비우면 본인):', _uid || '') || _uid;
    if (!targetUid) return;
    const count = parseInt(prompt('지급 수량:', '5') || '5');
    if (!count || count < 1) return;
    try {
      const res = await httpsCallable(functions, 'adminGivePotion')({ targetUid, count });
      alert(`✅ ${targetUid.slice(0,8)}… 에게 빨간약 ${res.data.given}병 지급 완료`);
      if (targetUid === _uid) await loadInventory();
    } catch (err) { alert('실패: ' + err.message); }
  });
  $('btnCancelPlace')?.addEventListener('click',  exitAdminPlaceMode);
  $('btnToggleTowerRange')?.addEventListener('click', toggleTowerRanges);

  // 스킬 버튼
  $('skillBtn0')?.addEventListener('click', castLightning);
  $('skillBtn1')?.addEventListener('click', castIceFreeze);
  $('skillBtn2')?.addEventListener('click', castFireStorm);
  $('skillBtnPotion')?.addEventListener('click', usePotion);

  // 키보드 단축키 1/2/3/4
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key === '1') castLightning();
    else if (e.key === '2') castIceFreeze();
    else if (e.key === '3') castFireStorm();
    else if (e.key === '4') usePotion();
  });

  // 전투 HUD 클릭 → 접기/펼치기 (모바일: 기본 접힘)
  $('combatHud')?.addEventListener('click', () => $('combatHud')?.classList.toggle('compact'));
  if (window.innerWidth <= 640) $('combatHud')?.classList.add('compact');

  updateSkillBar();

  // ── 게임 서버 초기화 ─────────────────────────────────────────────────────────
  // _ctx.playerLevel을 동적으로 battle 모듈에서 읽도록 getter 추가
  Object.defineProperty(_ctx, 'playerLevel', { get: () => getPlayerLevel(), configurable: true });

  initGameServer(_ctx, {
    onStateChange: (state) => {
      const btn   = $('btnGameToggle');
      const badge = $('gsStatusBadge');
      if (!btn) return;
      btn.classList.remove('gs-connecting', 'gs-connected', 'gs-error');
      if (state === 'connecting') {
        btn.classList.add('gs-connecting');
        btn.textContent = '⏳';
        btn.title = '연결 중...';
        if (badge) badge.textContent = '연결 중';
      } else if (state === 'connected') {
        btn.classList.add('gs-connected');
        btn.textContent = '■';
        btn.title = '게임 서버 접속 중 — 클릭하여 종료';
        if (badge) badge.textContent = '접속 중';
        renderBoxMarkers(); // 연결 시 보물박스 표시
      } else if (state === 'error') {
        btn.classList.add('gs-error');
        btn.textContent = '▶';
        btn.title = '연결 오류 — 클릭하여 재시도';
        if (badge) badge.textContent = '오류';
      } else {
        btn.textContent = '▶';
        btn.title = '게임 서버 연결';
        if (badge) badge.textContent = '';
        renderBoxMarkers(); // 연결 해제 시 보물박스 숨김
      }
    },
    onError:           (msg) => console.warn('[GS]', msg),
    onZoneSnapshot:    (data) => {
      // 기존 마커/오버레이 전체 제거
      Object.keys(_gsMarkers).forEach(id => { _gsMarkers[id].setMap(null); delete _gsMarkers[id]; });
      Object.keys(_gsOverlays).forEach(id => { _gsOverlays[id]?.setMap(null); delete _gsOverlays[id]; });
      _gsMonsters = {};
      data.monsters?.forEach(m => _renderGsMonster(m));
    },
    onMonsterUpdate:    (m) => _renderGsMonster(m),
    onMonsterDied:      (d) => _removeGsMonster(d.monsterId),
    onMonsterRespawned: (m) => _renderGsMonster(m),
    onDropSpawned:   (d)    => spawnGsDrop(d.dropId, d.lat, d.lng, d.gold ?? d.count, () => sendDropCollect(d.dropId)),
    onDropRemoved:   (d)   => removeGsDrop(d.dropId),
    onDropCollected: (d)   => { /* gold already added in spawnGsDrop click handler */ },
    onPlayerHit:    (data) => syncHpFromServer(data.remainHp, data.damage),
    onPlayerDied:   ()     => syncDeathFromServer(),
    onPlayerRevived:(data) => syncReviveFromServer(data.hp),
  });

  // WS 이벤트를 못 받은 경우 관리자 스폰 후 강제 렌더링
  window.addEventListener('gs:forceRenderMonster', (e) => _renderGsMonster(e.detail));

  $('btnGameToggle')?.addEventListener('click', () => {
    if (isGameServerConnected()) {
      disconnectFromGameServer();
    } else {
      // GPS 없는 PC 테스트: 지도 중심 좌표를 존 결정 기준으로 사용
      if (!_ctx.lastPos && map) {
        const c = map.getCenter();
        if (c) _ctx.lastPos = { lat: c.lat(), lng: c.lng(), accuracy: 10 };
      }
      connectToGameServer();
    }
  });

  // PC 모드: 맵 패닝 시 플레이어 위치를 맵 중심으로 자동 갱신
  // (accuracy === 10 이면 PC fallback 사용 중으로 판단)
  if (map) {
    map.addListener('idle', () => {
      if (!isGameServerConnected()) return;
      if (!_ctx.lastPos || _ctx.lastPos.accuracy > 5) {
        // 실제 GPS 없는 경우 → 맵 중심으로 업데이트
        const c = map.getCenter();
        if (c) _ctx.lastPos = { lat: c.lat(), lng: c.lng(), accuracy: 10 };
      }
    });
  }

  // ── Phase 2: 백그라운드에서 나머지 로드 (UI 블로킹 없음) ─────────────────────
  Promise.all([loadPlaces(), loadItems(), loadVouchers(), loadBattleData(), loadDecorations()]).then(() => {
    // 장소 마커 추가
    if (window.google?.maps) {
      renderPlaceMarkers();
      fitMapToAllMarkers();
    }
    // 인벤토리 초기 렌더
    renderBoxInventory();
    renderInventory();
    renderVouchers();
    renderExchangeSection();
  });
}

init();
