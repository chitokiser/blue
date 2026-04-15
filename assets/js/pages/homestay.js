// /assets/js/pages/homestay.js
// 홈스테이 목록: published items 중 category=hotel/homestay/guesthouse 만 표시
// NOTE: 리뷰/별점 SSOT는 top-level reviews 컬렉션

import { db } from "../firebase-init.js";
import {
  collection,
  query,
  where,
  limit,
  getDocs,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

import { toItemViewModel, renderItemCard } from "./index.lib.js";

const $ = (id) => document.getElementById(id);

function n(v, d = 0) {
  const x = Number(v);
  return Number.isFinite(x) ? x : d;
}

function tsSeconds(v) {
  if (!v) return 0;
  if (typeof v === "number") return v;
  if (typeof v === "object" && typeof v.seconds === "number") return v.seconds;
  return 0;
}

function chunkBy(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function loadReviewStatsMap(itemIds) {
  const ids = Array.from(new Set(itemIds.filter(Boolean)));
  const map = new Map();
  if (!ids.length) return map;

  for (const chunk of chunkBy(ids, 10)) {
    const q = query(
      collection(db, "reviews"),
      where("itemId", "in", chunk),
      limit(5000)
    );

    const snap = await getDocs(q);
    snap.forEach((d) => {
      const r = d.data() || {};
      if (r.visible === false) return;
      const itemId = String(r.itemId || "").trim();
      if (!itemId) return;

      const rating = Number(r.rating) || 0;
      if (!map.has(itemId)) map.set(itemId, { sum: 0, count: 0 });
      const cur = map.get(itemId);
      cur.sum += rating;
      cur.count += 1;
    });
  }

  const out = new Map();
  for (const [itemId, v] of map.entries()) {
    const count = Number(v.count) || 0;
    const avg = count > 0 ? Math.round((Number(v.sum) / count) * 10) / 10 : 0;
    out.set(itemId, { avg, count });
  }
  return out;
}

function matchSearch(it, q) {
  if (!q) return true;
  const s = q.toLowerCase();
  const hay = [it.title, it.region, it.category, it.guideName]
    .map((x) => String(x || "").toLowerCase())
    .join(" ");
  return hay.includes(s);
}

function matchCategory(it, countryFilter, regionFilter, typeFilter) {
  // 국가 필터 (region에서 추출 또는 별도 country 필드 사용)
  if (countryFilter) {
    const itemRegion = String(it.region || "").toLowerCase();
    const itemCountry = String(it.country || "").toLowerCase();

    // region에 국가 정보가 포함된 경우 추출
    let detectedCountry = itemCountry;
    if (!detectedCountry) {
      if (itemRegion.includes("베트남") || itemRegion.includes("vietnam")) detectedCountry = "vietnam";
      else if (itemRegion.includes("한국") || itemRegion.includes("korea")) detectedCountry = "korea";
      else detectedCountry = "other";
    }

    if (countryFilter !== detectedCountry) return false;
  }

  // 지역 필터
  if (regionFilter) {
    const itemRegion = String(it.region || "").toLowerCase();
    if (regionFilter === "oceanpark1" && !itemRegion.includes("그린1") && !itemRegion.includes("oceanpark1")) return false;
    if (regionFilter === "oceanpark2" && !itemRegion.includes("그린2") && !itemRegion.includes("oceanpark2")) return false;
    if (regionFilter === "oceanpark3" && !itemRegion.includes("그린3") && !itemRegion.includes("oceanpark3")) return false;
    if (regionFilter === "other") {
      const hasOceanPark = itemRegion.includes("그린") || itemRegion.includes("oceanpark");
      if (hasOceanPark) return false;
    }
  }

  // 숙박종류 필터
  if (typeFilter) {
    const itemType = String(it.category || "").toLowerCase();
    if (typeFilter === "homestay" && !itemType.includes("홈스테이") && !itemType.includes("homestay")) return false;
    if (typeFilter === "hotel" && !itemType.includes("호텔") && !itemType.includes("hotel")) return false;
    if (typeFilter === "motel" && !itemType.includes("모텔") && !itemType.includes("motel")) return false;
    if (typeFilter === "guesthouse" && !itemType.includes("게스트하우스") && !itemType.includes("guesthouse")) return false;
    if (typeFilter === "resort" && !itemType.includes("리조트") && !itemType.includes("resort")) return false;
    if (typeFilter === "villa" && !itemType.includes("빌라") && !itemType.includes("villa")) return false;
    if (typeFilter === "other") {
      const commonTypes = ["홈스테이", "호텔", "모텔", "게스트하우스", "리조트", "빌라", "homestay", "hotel", "motel", "guesthouse", "resort", "villa"];
      if (commonTypes.some(type => itemType.includes(type))) return false;
    }
  }

  return true;
}

function sortItems(items, mode) {
  const arr = items.slice();
  if (mode === "rating") {
    arr.sort((a, b) => {
      const ba = n(b.ratingAvg, 0), aa = n(a.ratingAvg, 0);
      if (ba !== aa) return ba - aa;
      return n(b.ratingCount, 0) - n(a.ratingCount, 0);
    });
    return arr;
  }
  if (mode === "reviews") {
    arr.sort((a, b) => n(b.ratingCount, 0) - n(a.ratingCount, 0));
    return arr;
  }
  arr.sort((a, b) => n(b._ts, 0) - n(a._ts, 0));
  return arr;
}

function renderGrid(items) {
  const q = ($("qSearch")?.value || "").trim();
  const sortMode = $("qSort")?.value || "recent";
  const countryFilter = $("qCountry")?.value || "";
  const regionFilter = $("qRegion")?.value || "";
  const typeFilter = $("qType")?.value || "";

  const filtered = items.filter((it) => {
    return matchSearch(it, q) && matchCategory(it, countryFilter, regionFilter, typeFilter);
  });
  const sorted = sortItems(filtered, sortMode);

  const state = $("itemsState");
  if (state) state.textContent = `총 ${sorted.length}개`;

  const grid = $("itemsGrid");
  if (grid) grid.innerHTML = sorted.map(renderItemCard).join("");
}

function isHomestayCategory(cat) {
  // 모바일/데스크탑/관리자 입력값이 섞여도 안전하게 판정
  const raw = String(cat || "").trim();
  const c = raw.toLowerCase();
  if (!c) return false;

  // 영문 코드(권장)
  if (c === "hotel" || c === "homestay" || c === "guesthouse") return true;

  // 한글(운영 중 혼재 가능)
  if (raw.includes("홈스테이") || raw.includes("숙박") || raw.includes("게스트하우스") || raw.includes("호텔") || raw.includes("민박")) {
    return true;
  }

  // 기타 흔한 표기
  if (c.includes("hotel") || c.includes("guest") || c.includes("stay") || c.includes("apartment") || c.includes("condo")) return true;

  return false;
}

async function loadPublishedHomestays() {
  const q = query(
    collection(db, "items"),
    where("status", "==", "published"),
    limit(500)
  );

  const snap = await getDocs(q);

  const items = [];
  snap.forEach((d) => {
    const data = d.data() || {};
    const vm = toItemViewModel(d.id, data);

    vm._ts = tsSeconds(data.createdAt);
    vm.guideUid = data.guideUid || data.ownerUid || "";
    vm.guideName = data.guideName || data.ownerName || "";

    const t = String((data.type || "")).toLowerCase();
    if (t) {
      if (t !== "homestay") return;
    } else {
      // 레거시( type 없음 )은 category로 판단
      if (!isHomestayCategory(vm.category)) return;
    }
    items.push(vm);
  });

  try {
    const ids = items.map((it) => it.id);
    const stats = await loadReviewStatsMap(ids);
    for (const it of items) {
      const s = stats.get(it.id);
      if (s) {
        it.ratingAvg = s.avg;
        it.ratingCount = s.count;
      } else {
        it.ratingAvg = n(it.ratingAvg, 0);
        it.ratingCount = n(it.ratingCount, 0);
      }
    }
  } catch (e) {
    console.warn("homestay: review stats load failed", e);
  }

  items.sort((a, b) => n(b._ts, 0) - n(a._ts, 0));
  return items;
}

(async function init() {
  try {
    const items = await loadPublishedHomestays();

    renderGrid(items);
    $("qSearch")?.addEventListener("input", () => renderGrid(items));
    $("qSort")?.addEventListener("change", () => renderGrid(items));
    $("qCountry")?.addEventListener("change", () => renderGrid(items));
    $("qRegion")?.addEventListener("change", () => renderGrid(items));
    $("qType")?.addEventListener("change", () => renderGrid(items));
  } catch (e) {
    console.error(e);
    const state = $("itemsState");
    if (state) state.textContent = "권한 또는 네트워크 문제로 불러오지 못했습니다.";
  }
})();
