// /assets/js/pages/index.lib.js
// (중요) index 페이지 렌더/로딩 공통 유틸

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (m) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  }[m]));
}

const CAT_LABEL = {
  spa: "스파",
  massage: "마사지",
  beauty: "뷰티/에스테틱",
  ticket: "티켓/입장권",
  tour: "투어",
  nature: "자연/액티비티",
  cruise: "크루즈/보트",
  food: "먹거리",
  cafe: "카페",
  night: "나이트/클럽",
  show: "공연/쇼",
  city: "도시/랜드마크",
  shopping: "쇼핑",
  hotel: "호텔/리조트",
  transport: "교통/이동",
  general: "살거리",
  etc: "기타",
};

export function catLabel(v) {
  const k = String(v || "").trim();
  return CAT_LABEL[k] || (k ? k : "기타");
}

function isUrl(x) {
  return typeof x === "string" && /^https?:\/\//i.test(x.trim());
}

function pickFirstUrl(arr) {
  for (const x of arr) {
    if (isUrl(x)) return x.trim();
  }
  return "";
}

export function normalizeImages(d) {
  const out = [];

  const pushOne = (v) => {
    if (!v) return;
    if (typeof v === "string") {
      const s = v.trim();
      if (s) out.push(s);
      return;
    }
    if (typeof v === "object") {
      const cands = [
        v.url, v.src, v.href, v.downloadURL, v.downloadUrl,
        v.imageUrl, v.imageURL, v.thumb, v.thumbnail,
      ];
      for (const c of cands) {
        if (isUrl(c)) {
          out.push(String(c).trim());
          return;
        }
      }
    }
  };

  const pushMany = (v) => {
    if (!v) return;
    if (Array.isArray(v)) {
      v.forEach(pushOne);
      return;
    }
    pushOne(v);
  };

  if (d && typeof d === "object") {
    if (Array.isArray(d.images)) pushMany(d.images);
    else if (typeof d.images === "string") {
      // 콤마/줄바꿈 분리 지원(값이 섞여 있어도 전체 로딩이 멈추지 않게)
      const parts = d.images.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
      pushMany(parts);
    }

    pushMany(d.imageUrls);
    pushMany(d.photoUrls);
    pushMany(d.photos);

    pushMany(d.thumbnail);
    pushMany(d.thumb);
    pushMany(d.imgUrl);
    pushMany(d.img);
    pushMany(d.imageUrl);
    pushMany(d.image);

    pushMany(d.image1);
    pushMany(d.image2);
    pushMany(d.image3);
    pushMany(d.image4);
  }

  const seen = new Set();
  const uniq = [];
  for (const u of out) {
    const s = String(u || "").trim();
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    uniq.push(s);
  }
  return uniq;
}

export function renderThumb(url, alt = "") {
  if (!url) {
    return `<div class="card-thumb card-thumb--empty" aria-hidden="true"></div>`;
  }
  const safe = esc(url);
  const safeAlt = esc(alt || "thumb");

  return `
    <div class="card-thumb">
      <img
        src="${safe}"
        alt="${safeAlt}"
        loading="lazy"
        referrerpolicy="no-referrer"
        onerror="this.onerror=null; this.closest('.card-thumb').innerHTML='<div class=&quot;card-thumb card-thumb--empty&quot; aria-hidden=&quot;true&quot;></div>';"
      />
    </div>`;
}

export function toItemViewModel(docId, data) {
  const d = data || {};
  const images = normalizeImages(d);
  return {
    id: docId,
    title: d.title || d.name || "",
    region: d.region || d.area || "",
    country: d.country || "",
    category: d.category || d.cat || "",
    price: d.price ?? d.amount ?? "",
    currency: d.currency || "KRW",
    status: d.status || "",
    images,
    thumb: pickFirstUrl(images),
    ratingAvg: d.ratingAvg ?? d.reviewAvg ?? d.avgRating ?? "",
    ratingCount: d.ratingCount ?? d.reviewCount ?? "",
  };
}

export function renderRatingInline(avg, count) {
  const a = Number(avg) || 0;
  const c = Number(count) || 0;
  const pct = Math.max(0, Math.min(100, (a / 5) * 100));
  const avgText = (Math.round(a * 10) / 10).toFixed(1);
  const countText = `(${c})`;
  return `
    <span class="rating-inline">
      <span class="rating-num">${esc(avgText)}</span>
      <span class="starbar" style="--pct:${pct.toFixed(0)}%"></span>
      <span class="rating-count">${esc(countText)}</span>
    </span>
  `;
}

export function renderItemCard(item) {
  const url = item.thumb || "";
  const thumb = renderThumb(url, item.title);

  const priceNum = Number(item.price);
  const currency = item.currency || "KRW";
  const priceText = (item.price !== "" && Number.isFinite(priceNum))
    ? `<span class="card-price">${priceNum.toLocaleString()} ${esc(currency)}</span>`
    : `<span class="card-price muted">가격 -</span>`;

  const rating = renderRatingInline(item.ratingAvg || 0, item.ratingCount || 0);

  return `
    <div class="card">
      <a class="card-link" href="./item.html?id=${encodeURIComponent(item.id)}">
        ${thumb}
        <div class="card-body">
          <div class="card-title">${esc(item.title || "(상품)")}</div>
          <div class="card-subline">
            ${priceText}
            <span class="dot">·</span>
            ${rating}
          </div>
          <div class="card-meta">
            <span class="badge">${esc(catLabel(item.category))}</span>
            ${item.region ? `<span class="badge">${esc(item.region)}</span>` : ""}
          </div>
          <div class="card-actions">
            <span class="btn btn-sm">상세</span>
          </div>
        </div>
      </a>
    </div>
  `;
}
