// /assets/js/pages/town_home.js
import { auth, db } from "/assets/js/auth.js";
import { functions } from "/assets/js/firebase-init.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-functions.js";
import {
  doc,
  getDoc,
  collection,
  query,
  where,
  orderBy,
  limit,
  getDocs,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

// ── 가맹점 캐시 (세션 내 1회만 fetch) ────────────────────────────────────────
let _merchantsCache = null;
async function fetchMerchantsOnce() {
  if (!_merchantsCache) _merchantsCache = await getDocs(collection(db, "merchants"));
  return _merchantsCache;
}

const $ = (id) => document.getElementById(id);

function escHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function formatHexForUi(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "-";
  return `${n.toLocaleString("ko-KR", { maximumFractionDigits: 2 })} HEX`;
}

function formatCount(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "-";
  return `${n.toLocaleString("ko-KR")}명`;
}

function getFxRates() {
  const src = window.__jackpotFx || {};
  const krw = Number(src.krw);
  const vnd = Number(src.vnd);
  return {
    krw: Number.isFinite(krw) && krw > 0 ? krw : 1380,
    vnd: Number.isFinite(vnd) && vnd > 0 ? vnd : 25000,
  };
}

function formatFiatLine(hexValue) {
  const n = Number(hexValue);
  if (!Number.isFinite(n)) return "약 - KRW / - VND";

  const fx = getFxRates();
  const krw = n * fx.krw;
  const vnd = n * fx.vnd;
  return `약 ${Math.round(krw).toLocaleString("ko-KR")} KRW / ${Math.round(vnd).toLocaleString("ko-KR")} VND`;
}

// ── 온체인 butPlatform 계약 상수 ────────────────────────────────────────
const OPBNB_RPC = 'https://opbnb-mainnet-rpc.bnbchain.org';
const BUTPLATFORM_ADDR = '0x93ded35508F56BA53C5653Eca736aDdfD994AFcd';

// ethers v6 UMD 버전 (global 사용)
let _ethersLoaded = false;
async function loadEthersLib() {
  if (_ethersLoaded || window.ethers) return true;
  try {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/ethers@6.10.0/dist/ethers.umd.min.js';
    await new Promise((resolve, reject) => {
      script.onload = () => { _ethersLoaded = true; resolve(); };
      script.onerror = reject;
      document.head.appendChild(script);
    });
    return true;
  } catch (e) {
    console.warn('ethers lib load failed:', e.message);
    return false;
  }
}

async function loadJackpotOnchain() {
  try {
    // ethers 라이브러리 로드
    const ok = await loadEthersLib();
    if (!ok || !window.ethers) throw new Error('ethers not loaded');

    const { ethers } = window;
    const provider = new ethers.JsonRpcProvider(OPBNB_RPC);
    
    // 간단한 호출: jackpotAccWei 읽기 (ABI 최소화)
    // BUTPLATFORM에 직접 call 호출
    const abi = ['function jackpotAccWei() view returns (uint256)'];
    const contract = new ethers.Contract(BUTPLATFORM_ADDR, abi, provider);
    
    const jackpotWei = await contract.jackpotAccWei();
    const jackpotHex = Number(jackpotWei) / 1e18;
    
    return { jackpotHex };
  } catch (e) {
    console.warn('loadJackpotOnchain failed:', e.message);
    return null;
  }
}

function setJackpotUi({ valueText, fiatText, updatedText, winnerCountText, highestWinText }) {
  const valueEl = $("jackpotDisplayValue");
  const fiatEl = $("jackpotFiatValue");
  const updatedEl = $("jackpotUpdated");
  const winnerEl = $("jackpotWinnerCount");
  const highestEl = $("jackpotHighestWin");

  if (valueEl) valueEl.textContent = valueText;
  if (fiatEl) fiatEl.textContent = fiatText;
  if (updatedEl) updatedEl.innerHTML = `<span class="jackpot-dot"></span>${escHtml(updatedText)}`;
  if (winnerEl) winnerEl.textContent = winnerCountText;
  if (highestEl) highestEl.textContent = highestWinText;
}

async function loadJackpotCurrent() {
  try {
    const chainData = await loadJackpotOnchain();
    const now = new Date();

    if (!chainData) {
      setJackpotUi({
        valueText: "연결 대기중",
        fiatText: "약 - KRW / - VND",
        updatedText: "온체인 데이터 로드 실패",
        winnerCountText: "-",
        highestWinText: "- HEX",
      });
      return;
    }

    const { jackpotHex } = chainData;

    // 당첨자 정보는 Firestore에서 조회 (선택사항)
    let winnerCountText = "-";
    let highestWinText = "- HEX";

    try {
      const snap = await getDocs(
        query(collection(db, "jackpot_winners"), orderBy("timestamp", "desc"), limit(100))
      );
      if (!snap.empty) {
        winnerCountText = formatCount(snap.size);
        // 최고 당첨금 찾기
        let maxWei = 0n;
        snap.forEach(doc => {
          const data = doc.data();
          const wei = BigInt(data.winAmount || 0);
          if (wei > maxWei) maxWei = wei;
        });
        if (maxWei > 0n) {
          highestWinText = formatHexForUi(Number(maxWei) / 1e18);
        }
      }
    } catch (e) {
      console.warn("loadJackpot winners Firestore failed:", e.message);
    }

    setJackpotUi({
      valueText: formatHexForUi(jackpotHex),
      fiatText: formatFiatLine(jackpotHex),
      updatedText: `${now.toLocaleTimeString("ko-KR", { hour12: false })} 온체인 조회`,
      winnerCountText,
      highestWinText,
    });
  } catch (e) {
    console.warn("loadJackpotCurrent failed:", e.message);
    setJackpotUi({
      valueText: "연결 대기중",
      fiatText: "약 - KRW / - VND",
      updatedText: "잭팟 데이터를 불러올 수 없습니다",
      winnerCountText: "-",
      highestWinText: "- HEX",
    });
  }
}

function initJackpotTicker() {
  if (!$("jackpotSection")) return;
  loadJackpotCurrent();
  setInterval(loadJackpotCurrent, 15000);
}

// ── 당첨자 목록 & 공유 카드 ──────────────────────────────
let _userLevel = 0;
let _userWalletAddr = "";
let _jackpotWinners = [];

async function loadJackpotWinners() {
  const wrap = $("jackpotWinnersList");
  if (!wrap) return;

  try {
    // 온체인 당첨 기록 조회 (Firestore: jackpot_winners 컬렉션)
    let snap;
    try {
      snap = await getDocs(
        query(
          collection(db, "jackpot_winners"),
          orderBy("timestamp", "desc"),
          limit(50)
        )
      );
    } catch (e) {
      console.warn("jackpot_winners query failed:", e.message);
      wrap.innerHTML = '<p class="jp-winners-empty">아직 당첨자가 없습니다.</p>';
      return;
    }

    const winners = [];
    snap.forEach((d) => {
      const r = d.data();
      if (!r.isWinner && Number(r.finalWinSort || 0) <= 0) return;
      const hexVal = Number(BigInt(r.finalWinWei || "0")) / 1e18;
      if (hexVal <= 0) return;
      const fx = getFxRates();
      const krwStr = Math.round(hexVal * fx.krw).toLocaleString("ko-KR");
      const vndStr = Math.round(hexVal * fx.vnd).toLocaleString("ko-KR");
      const addr = String(r.userAddress || "");
      const addrShort = addr.length > 8 ? addr.slice(0, 6) + "..." + addr.slice(-4) : addr || "-";
      const merchantId = String(r.merchantId ?? "");
      const merchantName = merchantMap.get(merchantId) || (merchantId ? `가맹점 #${merchantId}` : "-");
      const createdAt = r.createdAt?.toDate ? r.createdAt.toDate() : null;
      const dateStr = createdAt
        ? createdAt.toLocaleDateString("ko-KR", { month: "short", day: "numeric" }) +
          " " +
          createdAt.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false })
        : "-";
      winners.push({ hexVal, krwStr, vndStr, addrShort, merchantName, dateStr, _ts: createdAt ? createdAt.getTime() : 0 });
    });

    // 맨 위: 최고금액 당첨자 1개 / 나머지: 최신순
    if (winners.length > 1) {
      let topIdx = 0;
      for (let i = 1; i < winners.length; i++) {
        if (winners[i].hexVal > winners[topIdx].hexVal) topIdx = i;
      }
      const [topWinner] = winners.splice(topIdx, 1);
      winners.sort((a, b) => b._ts - a._ts);
      winners.unshift(topWinner);
    }

    _jackpotWinners = winners;

    if (!winners.length) {
      wrap.innerHTML = '<p class="jp-winners-empty">아직 당첨자가 없습니다.</p>';
      return;
    }

    const INITIAL_SHOW = 5;
    const makeRow = (w, i) => `
      <div class="jp-winner-row${i === 0 ? " jp-winner-top" : ""}">
        <div class="jp-winner-info">
          <div class="jp-winner-amount">${i === 0 ? "&#x1F3C6; " : ""}${w.hexVal.toLocaleString("ko-KR", { maximumFractionDigits: 4 })} HEX</div>
          <div class="jp-winner-fiat">&#x2248; ${w.krwStr} KRW / ${w.vndStr} VND</div>
          <div class="jp-winner-meta">
            <span class="jp-winner-tag">&#x1F464; ${escHtml(w.addrShort)}</span>
            <span class="jp-winner-tag">&#x1F3EA; ${escHtml(w.merchantName)}</span>
            <span class="jp-winner-tag">&#x1F4C5; ${escHtml(w.dateStr)}</span>
          </div>
        </div>
        <button class="jp-share-btn" data-win-idx="${i}" type="button">&#x1F4E4; 공유</button>
      </div>`;

    const visibleRows = winners.slice(0, INITIAL_SHOW).map(makeRow).join("");
    const hiddenRows = winners.length > INITIAL_SHOW
      ? `<div id="jpWinnersHidden" style="display:none;">${winners.slice(INITIAL_SHOW).map(makeRow).join("")}</div>
         <button class="jp-winners-more-btn" id="jpWinnersMoreBtn" type="button">&#x25BC; 더 보기 (${winners.length - INITIAL_SHOW}건 더)</button>`
      : "";

    wrap.innerHTML = visibleRows + hiddenRows;

    const moreBtn = $("jpWinnersMoreBtn");
    if (moreBtn) {
      moreBtn.onclick = () => {
        $("jpWinnersHidden").style.display = "";
        moreBtn.style.display = "none";
      };
    }

    // 공유 버튼 이벤트
    wrap.addEventListener("click", (e) => {
      const btn = e.target.closest(".jp-share-btn");
      if (!btn) return;
      const idx = parseInt(btn.dataset.winIdx, 10);
      if (Number.isFinite(idx) && _jackpotWinners[idx]) {
        openShareModal(_jackpotWinners[idx]);
      }
    });
  } catch (err) {
    console.warn("loadJackpotWinners failed:", err);
    wrap.innerHTML = '<p class="jp-winners-empty">당첨자 정보를 불러오지 못했습니다.</p>';
  }
}

function buildShareCardHTML(winner) {
  const hasRef = _userLevel >= 4 && _userWalletAddr;
  const registerUrl = hasRef
    ? `/register.html?mentor=${encodeURIComponent(_userWalletAddr)}`
    : `/register.html`;

  const refBlock = hasRef
    ? `<hr class="jp-sc-divider">
       <a class="jp-sc-reg-btn" href="${escHtml(registerUrl)}" target="_blank" rel="noopener">
         &#x2728; JUMP 지금 가입하기 &#x2192;
       </a>
       <p class="jp-sc-ref-note">&#x1F517; 내 레퍼럴 코드가 자동으로 포함됩니다</p>`
    : `<hr class="jp-sc-divider">
       <a class="jp-sc-reg-btn" href="/register.html" target="_blank" rel="noopener">
         &#x2728; JUMP 회원가입 &#x2192;
       </a>`;

  return `
    <div class="jp-share-card">
      <button class="jp-sc-x" id="jpShareClose" aria-label="닫기">&#x00D7;</button>
      <div class="jp-share-inner">
        <div class="jp-sc-badge">&#x1F3B0; JUMP MERCHANT PAY JACKPOT</div>
        <img class="jp-sc-logo" src="/assets/images/jump/logo2.png" alt="JUMP" />
        <div class="jp-sc-headline">잭팟 당첨!</div>
        <div class="jp-sc-amount">${winner.hexVal.toLocaleString("ko-KR", { maximumFractionDigits: 4 })} HEX</div>
        <div class="jp-sc-fiat">&#x2248; ${winner.krwStr} KRW / ${winner.vndStr} VND</div>
        <hr class="jp-sc-divider">
        <div class="jp-sc-kv">
          <span class="k">&#x1F464; 당첨자</span>
          <span class="v" style="font-family:monospace;font-size:12px;">${escHtml(winner.addrShort)}</span>
        </div>
        <div class="jp-sc-kv">
          <span class="k">&#x1F3EA; 결제 가맹점</span>
          <span class="v">${escHtml(winner.merchantName)}</span>
        </div>
        <div class="jp-sc-kv">
          <span class="k">&#x1F4C5; 당첨 일시</span>
          <span class="v">${escHtml(winner.dateStr)}</span>
        </div>
        ${refBlock}
        <button class="jp-sc-kakao-btn" id="jpShareKakao" type="button">
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none"><ellipse cx="9" cy="8.4" rx="8" ry="6.6" fill="#191919"/><path d="M5.1 11.2l1-3.1.9 2.1 1-.4.9 1.4-1.1-3.3 1.2-1.3H7.6l-.5-1.2-.6 1.2H5.3l1.1 1.3-1.3 3.3z" fill="#FEE500"/></svg>
          카카오톡으로 공유
        </button>
        <div class="jp-sc-actions">
          <button class="jp-sc-img-btn" id="jpShareImg" type="button">&#x1F4F7; 이미지 복사</button>
          <button class="jp-sc-copy-btn" id="jpShareCopy" type="button">&#x1F517; 링크 복사</button>
        </div>
        <button class="jp-sc-close-btn" id="jpShareCloseBtn" type="button" style="width:100%;margin-top:6px;">닫기</button>
      </div>
    </div>`;
}

function openShareModal(winner) {
  const modal = $("jackpotShareModal");
  if (!modal) return;

  modal.innerHTML = buildShareCardHTML(winner);
  modal.style.display = "flex";

  const close = () => { modal.style.display = "none"; };
  modal.addEventListener("click", (e) => { if (e.target === modal) close(); }, { once: true });
  $("jpShareClose").onclick = close;
  $("jpShareCloseBtn").onclick = close;

  const hasRef = _userLevel >= 4 && _userWalletAddr;
  const shareParams = new URLSearchParams({
    hex: winner.hexVal.toFixed(4),
    krw: winner.krwStr,
    vnd: winner.vndStr,
    addr: winner.addrShort,
    merchant: winner.merchantName,
    date: winner.dateStr,
    ...(hasRef ? { mentor: _userWalletAddr } : {}),
  });
  const copyUrl = `${location.origin}/share.html?${shareParams}`;

  $("jpShareCopy").onclick = () => {
    const btn = $("jpShareCopy");
    navigator.clipboard?.writeText(copyUrl).then(() => {
      btn.innerHTML = "&#x2705; 복사됨!";
      setTimeout(() => { btn.innerHTML = "&#x1F517; 링크 복사"; }, 2500);
    }).catch(() => { btn.textContent = "복사 실패"; });
  };

  $("jpShareImg").onclick = async () => {
    const btn = $("jpShareImg");
    const card = document.querySelector(".jp-share-card");
    if (!card || typeof window.html2canvas === "undefined") {
      btn.textContent = "미지원 브라우저";
      return;
    }
    btn.disabled = true;
    btn.textContent = "캡처 중...";
    try {
      const canvas = await window.html2canvas(card, {
        scale: 2,
        useCORS: true,
        backgroundColor: null,
        logging: false,
        ignoreElements: (el) => el.id === "jpShareImg" || el.id === "jpShareClose",
      });
      canvas.toBlob(async (blob) => {
        try {
          await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
          btn.innerHTML = "&#x2705; 복사됨! 카톡에 붙여넣기";
          btn.disabled = false;
          setTimeout(() => { btn.innerHTML = "&#x1F4F7; 이미지 복사"; }, 3000);
        } catch {
          // 클립보드 미지원 시 다운로드로 폴백
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = "jump-jackpot.png";
          a.click();
          URL.revokeObjectURL(url);
          btn.innerHTML = "&#x2705; 이미지 저장됨";
          btn.disabled = false;
          setTimeout(() => { btn.innerHTML = "&#x1F4F7; 이미지 복사"; }, 3000);
        }
      }, "image/png");
    } catch (err) {
      btn.disabled = false;
      btn.textContent = "캡처 실패";
      console.warn("html2canvas error:", err);
    }
  };

  $("jpShareKakao").onclick = async () => {
    const btn = $("jpShareKakao");
    if (navigator.share) {
      try {
        await navigator.share({
          title: `🏆 잭팟 당첨! ${winner.hexVal.toFixed(4)} HEX`,
          text: `≈ ${winner.krwStr} KRW / ${winner.vndStr} VND · ${winner.merchantName}`,
          url: copyUrl,
        });
      } catch (err) {
        if (err.name !== "AbortError") console.warn("share failed:", err);
      }
    } else {
      navigator.clipboard?.writeText(copyUrl).then(() => {
        btn.textContent = "✅ 링크 복사됨! 카카오톡에 붙여넣기";
        setTimeout(() => {
          btn.innerHTML = `<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><ellipse cx="9" cy="8.4" rx="8" ry="6.6" fill="#191919"/><path d="M5.1 11.2l1-3.1.9 2.1 1-.4.9 1.4-1.1-3.3 1.2-1.3H7.6l-.5-1.2-.6 1.2H5.3l1.1 1.3-1.3 3.3z" fill="#FEE500"/></svg> 카카오톡으로 공유`;
        }, 2500);
      }).catch(() => { btn.textContent = "복사 실패"; });
    }
  };
}

async function isAdmin(uid) {
  if (!uid) return false;
  try {
    const snap = await getDoc(doc(db, "admins", uid));
    return snap.exists();
  } catch {
    return false;
  }
}

function setupAdminUI(admin) {
  const btnAdminPlace = $("btnAdminPlace");
  const noticeAdminLink = $("noticeAdminLink");
  if (btnAdminPlace) btnAdminPlace.style.display = admin ? "" : "none";
  if (noticeAdminLink) noticeAdminLink.style.display = admin ? "" : "none";
}

function makeNoticeRow(v) {
  const li = document.createElement("li");
  li.className = "notice-row";

  const head = document.createElement("button");
  head.type = "button";
  head.className = "notice-head";
  head.textContent = v.title || v.text || "(제목 없음)";

  const body = document.createElement("div");
  body.className = "notice-body";
  body.textContent = v.text || "";
  body.style.display = "none";

  head.onclick = () => {
    body.style.display = body.style.display === "none" ? "block" : "none";
  };

  li.appendChild(head);
  li.appendChild(body);
  return li;
}

async function loadNotices() {
  const list = $("noticeList");
  if (!list) return;
  list.innerHTML = "";

  try {
    const snap = await getDocs(
      query(collection(db, "notices"), orderBy("createdAt", "desc"), limit(30))
    );

    const docs = [];
    snap.forEach((d) => docs.push(d.data() || {}));

    const visible = docs
      .filter((v) => v.visible !== false)
      .sort((a, b) => {
        const ap = a.pinned ? 1 : 0;
        const bp = b.pinned ? 1 : 0;
        if (ap !== bp) return bp - ap;
        const am = typeof a.createdAt?.toMillis === "function" ? a.createdAt.toMillis() : 0;
        const bm = typeof b.createdAt?.toMillis === "function" ? b.createdAt.toMillis() : 0;
        return bm - am;
      });

    visible.forEach((v, i) => {
      const row = makeNoticeRow(v);
      if (i >= 5) row.style.display = "none";
      list.appendChild(row);
    });

    if (!list.children.length) {
      const li = document.createElement("li");
      li.textContent = "표시할 공지사항이 없습니다.";
      list.appendChild(li);
    }

    const moreBtn = $("noticeMoreBtn");
    if (moreBtn) {
      if (visible.length > 5) {
        moreBtn.style.display = "";
        moreBtn.onclick = () => {
          list.querySelectorAll("li[style*='display: none'], li[style*='display:none']").forEach((el) => (el.style.display = ""));
          moreBtn.style.display = "none";
        };
      } else {
        moreBtn.style.display = "none";
      }
    }
  } catch (e) {
    console.warn("loadNotices failed:", e);
    const li = document.createElement("li");
    li.textContent = "공지사항을 불러오지 못했습니다.";
    list.appendChild(li);
  }
}

function renderMerchantCard(mid, m) {
  const name = m.name || "가맹점";
  const career = m.career || "";
  const region = m.region || "";
  const desc = m.description || "";
  const ownerUid = m.ownerUid || "";

  return `
    <div class="merchant-card">
      <div class="merchant-card-head">
        <span class="merchant-name">${escHtml(name)}</span>
        ${career ? `<span class="merchant-career">${escHtml(career)}</span>` : ""}
      </div>
      ${region ? `<div class="merchant-region">📍 ${escHtml(region)}</div>` : ""}
      ${desc ? `<div class="merchant-desc">${escHtml(desc)}</div>` : ""}
      <div class="merchant-id">가맹점 ID: ${escHtml(String(mid))}</div>
      ${ownerUid ? `<button class="btn-merchant-products" type="button" data-owner-uid="${escHtml(ownerUid)}" data-merchant-name="${escHtml(name)}">상품 보기</button>` : ""}
    </div>`;
}

let merchantGridBound = false;

async function loadMerchants() {
  const grid = $("merchantListGrid");
  const state = $("merchantListState");
  if (!grid) return;

  if (state) state.textContent = "불러오는 중...";

  try {
    const snap = await fetchMerchantsOnce();
    const list = [];
    snap.forEach((d) => {
      const m = d.data() || {};
      if (m.active !== false) list.push({ id: d.id, ...m });
    });

    if (state) state.textContent = `총 ${list.length}개`;

    if (!list.length) {
      grid.innerHTML = '<p class="help">등록된 가맹점이 없습니다.</p>';
      return;
    }

    grid.innerHTML = list.map((m) => renderMerchantCard(m.id, m)).join("");

    if (!merchantGridBound) {
      merchantGridBound = true;
      grid.addEventListener("click", (e) => {
        const btn = e.target.closest(".btn-merchant-products");
        if (!btn) return;
        const ownerUid = btn.dataset.ownerUid;
        const merchantName = btn.dataset.merchantName;
        if (ownerUid) openMerchantProductModal(ownerUid, merchantName);
      });
    }
  } catch (e) {
    console.warn("loadMerchants failed:", e);
    if (state) state.textContent = "가맹점 목록을 불러오지 못했습니다.";
  }
}

const TYPE_COLOR = {
  homestay: "#6366f1",
  restaurant: "#f97316",
  food: "#f97316",
  cafe: "#854d0e",
  hospital: "#ef4444",
  school: "#16a34a",
  park: "#22c55e",
  shopping: "#ec4899",
};

function getMarkerColor(type) {
  return TYPE_COLOR[String(type).toLowerCase()] || "#6b7280";
}

function loadMapsScript() {
  return new Promise((resolve, reject) => {
    if (window.google?.maps) return resolve();
    window.__gmapsCb = resolve;
    const s = document.createElement("script");
    s.src = `https://maps.googleapis.com/maps/api/js?key=${window.__mapsKey || ""}&callback=__gmapsCb&language=ko&region=KR`;
    s.async = true;
    s.onerror = () => reject(new Error("Google Maps 로드 실패"));
    document.head.appendChild(s);
  });
}

function parseLatLng(gmapUrl) {
  if (!gmapUrl) return null;
  try {
    const m1 = gmapUrl.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
    if (m1) return { lat: parseFloat(m1[1]), lng: parseFloat(m1[2]) };
    const url = new URL(gmapUrl);
    const q = url.searchParams.get("q");
    if (q) {
      const m2 = q.match(/^(-?\d+\.\d+),(-?\d+\.\d+)$/);
      if (m2) return { lat: parseFloat(m2[1]), lng: parseFloat(m2[2]) };
    }
  } catch {}
  return null;
}

function makeSvgIcon(emoji, fillColor, size = 36) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <circle cx="${size/2}" cy="${size/2}" r="${size/2-1}" fill="${fillColor}" stroke="#fff" stroke-width="2"/>
    <text x="${size/2}" y="${size*0.68}" font-size="${size*0.5}" text-anchor="middle">${emoji}</text></svg>`;
  return { url: "data:image/svg+xml;charset=UTF-8," + encodeURIComponent(svg),
           scaledSize: new google.maps.Size(size, size), anchor: new google.maps.Point(size/2, size/2) };
}

async function loadPlacesMap() {
  const mapEl = $("villageMap");
  if (!mapEl) return;

  if (!window.__mapsKey) {
    mapEl.innerHTML = '<div style="padding:32px;text-align:center;color:#9ca3af;">Google Maps API 키가 없습니다.</div>';
    return;
  }

  try {
    await loadMapsScript();

    const settle = p => p.then(v => ({ ok: true, v })).catch(() => ({ ok: false }));
    const [placesRes, merchantsRes] = await Promise.all([
      settle(getDocs(collection(db, "places"))),
      settle(fetchMerchantsOnce()),
    ]);

    const map = new google.maps.Map(mapEl, {
      center: { lat: 20.9947, lng: 105.9487 },
      zoom: 15,
      mapTypeControl: false,
      streetViewControl: false,
      fullscreenControl: true,
      gestureHandling: 'greedy',
    });

    const bounds = new google.maps.LatLngBounds();
    const infoWindow = new google.maps.InfoWindow();
    let markerCount = 0;

    function addMarker(latLng, icon, content, zIndex = 1) {
      const marker = new google.maps.Marker({ position: latLng, map, icon, zIndex });
      bounds.extend(latLng);
      markerCount++;
      marker.addListener("click", () => { infoWindow.setContent(content); infoWindow.open(map, marker); });
    }

    // ── 장소 마커
    if (placesRes.ok) placesRes.v.forEach((d) => {
      const p = d.data() || {};
      if (p.visible === false) return;
      const latLng = (typeof p.lat === "number" && typeof p.lng === "number") ? { lat: p.lat, lng: p.lng } : parseLatLng(p.gmap);
      if (!latLng) return;
      addMarker(latLng,
        { path: google.maps.SymbolPath.CIRCLE, fillColor: getMarkerColor(p.type), fillOpacity: 1, strokeColor: "#fff", strokeWeight: 2, scale: 9 },
        `<div style="max-width:240px;font-size:13px;line-height:1.5;">
          <div style="font-weight:700;font-size:14px;margin-bottom:4px;">${escHtml(p.name || "")}</div>
          ${p.type ? `<div style="color:#7c3aed;margin-bottom:2px;">${escHtml(p.type)}</div>` : ""}
          ${p.area    ? `<div style="color:#6b7280;">구역: ${escHtml(p.area)}</div>` : ""}
          ${p.address ? `<div style="color:#374151;">${escHtml(p.address)}</div>` : ""}
          ${p.phone   ? `<div style="color:#374151;">${escHtml(p.phone)}</div>` : ""}
          ${p.note    ? `<div style="color:#6b7280;margin-top:4px;">${escHtml(p.note)}</div>` : ""}
          ${p.gmap    ? `<a href="${escHtml(p.gmap)}" target="_blank" rel="noopener" style="display:inline-block;margin-top:6px;color:#2563eb;">구글 지도에서 보기</a>` : ""}
        </div>`);
    });

    // ── 가맹점 마커 (imageUrl 반영)
    if (merchantsRes.ok) merchantsRes.v.forEach((d) => {
      const m = d.data() || {};
      const hasCoords = (typeof m.lat === "number" && typeof m.lng === "number") || m.gmap;
      if (m.active === false || !hasCoords) return;
      const latLng = (typeof m.lat === "number" && typeof m.lng === "number") ? { lat: m.lat, lng: m.lng } : parseLatLng(m.gmap);
      if (!latLng) return;
      const icon = m.imageUrl
        ? { url: m.imageUrl, scaledSize: new google.maps.Size(36, 36), anchor: new google.maps.Point(18, 18) }
        : { url: "/assets/images/jump/favicon.png", scaledSize: new google.maps.Size(18, 18), anchor: new google.maps.Point(9, 9) };
      addMarker(latLng, icon,
        `<div style="max-width:240px;font-size:13px;line-height:1.5;">
          ${m.imageUrl ? `<img src="${escHtml(m.imageUrl)}" style="width:100%;max-height:100px;object-fit:cover;border-radius:6px;margin-bottom:6px;">` : ""}
          <div style="font-weight:700;font-size:14px;margin-bottom:4px;">🏪 ${escHtml(m.name || "가맹점")}</div>
          ${m.career      ? `<div style="color:#f59e0b;font-size:12px;">${escHtml(m.career)}</div>` : ""}
          ${m.region      ? `<div style="color:#6b7280;">📍 ${escHtml(m.region)}</div>` : ""}
          ${m.phone       ? `<div style="color:#374151;">📞 ${escHtml(m.phone)}</div>` : ""}
          ${m.description ? `<div style="color:#6b7280;margin-top:4px;">${escHtml(m.description)}</div>` : ""}
          ${m.gmap        ? `<a href="${escHtml(m.gmap)}" target="_blank" rel="noopener" style="display:inline-block;margin-top:6px;color:#2563eb;font-size:12px;">구글 지도에서 보기 →</a>` : ""}
        </div>`, 10);
    });


    if (markerCount > 0 && !bounds.isEmpty()) {
      map.fitBounds(bounds);
      google.maps.event.addListenerOnce(map, "bounds_changed", () => {
        if (map.getZoom() > 17) map.setZoom(17);
      });
    }
  } catch (e) {
    console.warn("loadPlacesMap failed:", e);
    mapEl.innerHTML = `<div style="padding:32px;text-align:center;color:#9ca3af;">지도를 불러오지 못했습니다.<br><small>${e.message || ""}</small></div>`;
  }
}

function renderProductCard(p) {
  const thumb = Array.isArray(p.images) && p.images[0] ? p.images[0] : null;
  const price = p.price ? `${Number(p.price).toLocaleString()}원` : "가격 문의";
  return `
    <a class="mp-product-card" href="/item.html?id=${escHtml(p.id)}" target="_blank" rel="noopener">
      ${thumb ? `<img class="mp-product-thumb" src="${escHtml(thumb)}" alt="${escHtml(p.title || "")}" loading="lazy">` : `<div class="mp-product-thumb-ph">📦</div>`}
      <div class="mp-product-body">
        <div class="mp-product-title">${escHtml(p.title || "")}</div>
        ${p.region ? `<div class="mp-product-region">📍 ${escHtml(p.region)}</div>` : ""}
        <div class="mp-product-price">${escHtml(price)}</div>
      </div>
    </a>`;
}

function closeMerchantProductModal() {
  const modal = $("merchantProductsModal");
  if (modal) modal.style.display = "none";
}

function openMerchantProductModal(ownerUid, merchantName) {
  const modal = $("merchantProductsModal");
  const title = $("mpModalTitle");
  const stateEl = $("mpModalState");
  const grid = $("mpModalGrid");
  if (!modal || !grid) return;

  if (title) title.textContent = `${merchantName || "가맹점"} 상품 목록`;
  if (stateEl) stateEl.textContent = "불러오는 중...";
  grid.innerHTML = "";
  modal.style.display = "flex";

  const closeBtn = $("mpModalClose");
  const backdrop = $("mpModalBackdrop");
  if (closeBtn) closeBtn.onclick = closeMerchantProductModal;
  if (backdrop) backdrop.onclick = closeMerchantProductModal;

  const onKey = (e) => {
    if (e.key === "Escape") {
      closeMerchantProductModal();
      window.removeEventListener("keydown", onKey);
    }
  };
  window.addEventListener("keydown", onKey);

  const q = query(
    collection(db, "items"),
    where("ownerUid", "==", ownerUid),
    where("status", "in", ["published", "approved"])
  );

  getDocs(q)
    .then((snap) => {
      const list = [];
      snap.forEach((d) => list.push({ id: d.id, ...d.data() }));

      if (!list.length) {
        if (stateEl) stateEl.textContent = "등록된 상품이 없습니다.";
        return;
      }

      if (stateEl) stateEl.textContent = `총 ${list.length}개`;
      grid.innerHTML = list.map(renderProductCard).join("");
    })
    .catch((e) => {
      console.warn("loadMerchantProducts failed:", e);
      if (stateEl) stateEl.textContent = "상품 목록을 불러오지 못했습니다.";
    });
}

function renderCoopCard(p) {
  const imgHtml = p.imageUrl
    ? `<img class="mp-product-thumb" src="${escHtml(p.imageUrl)}" alt="${escHtml(p.name)}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';"><div class="mp-product-thumb-ph" style="display:none;">📦</div>`
    : `<div class="mp-product-thumb-ph">📦</div>`;

  const typeBadge = p.type === "voucher"
    ? `<span style="font-size:0.7rem;background:#fef3c7;color:#92400e;border-radius:99px;padding:1px 7px;display:inline-block;margin-bottom:3px;">바우처</span>`
    : `<span style="font-size:0.7rem;background:#e0e7ff;color:#3730a3;border-radius:99px;padding:1px 7px;display:inline-block;margin-bottom:3px;">일반상품</span>`;

  return `
    <a class="mp-product-card" href="/coop.html">
      ${imgHtml}
      <div class="mp-product-body">
        ${typeBadge}
        <div class="mp-product-title">${escHtml(p.name)}</div>
        <div class="mp-product-price">${Number(p.price || 0).toLocaleString()} 원</div>
      </div>
    </a>`;
}

async function loadCoopProducts() {
  const grid = $("coopProductsGrid");
  if (!grid) return;

  try {
    const snap = await getDocs(query(collection(db, "coopProducts"), where("active", "==", true)));
    const list = [];
    snap.forEach((d) => list.push({ id: d.id, ...d.data() }));
    list.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));

    if (!list.length) {
      const sec = $("coopProductsSection");
      if (sec) sec.style.display = "none";
      return;
    }

    grid.innerHTML = list.map(renderCoopCard).join("");
  } catch (e) {
    console.warn("loadCoopProducts failed:", e);
    const sec = $("coopProductsSection");
    if (sec) sec.style.display = "none";
  }
}

function usedStateText(s) {
  return s === "sold" ? "판매완료" : s === "reserved" ? "예약중" : "판매중";
}

function usedThumb(post) {
  if (Array.isArray(post?.imageUrls) && post.imageUrls[0]) return post.imageUrls[0];
  if (post?.imageUrl) return post.imageUrl;
  return "/assets/images/jump/BI.png";
}

function renderUsedCard(post) {
  return `
    <a class="used-card" href="/used-market-item.html?id=${encodeURIComponent(post.id)}">
      <img class="used-thumb" src="${escHtml(usedThumb(post))}" alt="${escHtml(post.title || "중고물품")}" loading="lazy" />
      <div class="used-body">
        <div class="used-title">${escHtml(post.title || "제목 없음")}</div>
        <div class="used-meta">
          <span class="used-price">${Number(post.price || 0).toLocaleString()}원</span>
          <span class="used-state">${usedStateText(post.status)}</span>
        </div>
      </div>
    </a>`;
}

async function loadUsedMarketPreview() {
  const grid = $("usedMarketPreviewGrid");
  const state = $("usedMarketPreviewState");
  if (!grid) return;

  if (state) state.textContent = "불러오는 중...";
  try {
    const snap = await getDocs(query(collection(db, "usedMarketPosts"), orderBy("createdAt", "desc"), limit(8)));
    const list = [];
    snap.forEach((d) => list.push({ id: d.id, ...d.data() }));

    if (!list.length) {
      if (state) state.textContent = "등록된 중고물품이 없습니다.";
      grid.innerHTML = "";
      return;
    }

    if (state) state.textContent = `최신 ${list.length}개`;
    grid.innerHTML = list.map(renderUsedCard).join("");
  } catch (e) {
    console.warn("loadUsedMarketPreview failed:", e);
    if (state) state.textContent = "중고물품을 불러오지 못했습니다.";
  }
}
async function loadSponsorBannersFromDb() {
  try {
    const snap = await getDocs(query(collection(db, "sponsorBanners"), limit(20)));
    const rows = [];
    snap.forEach((d) => rows.push({ id: d.id, ...d.data() }));
    return rows
      .filter((x) => x.active !== false)
      .sort((a, b) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0));
  } catch (e) {
    console.warn("loadSponsorBannersFromDb failed:", e);
    return [];
  }
}

function sponsorSlideHtml(row, idx) {
  const title = escHtml(row.title || "스폰서");
  const subtitle = escHtml(row.subtitle || "");
  const imageUrl = escHtml(row.imageUrl || "/assets/images/jump/BI.png");
  const linkUrl = escHtml(row.linkUrl || "/");
  const activeClass = idx === 0 ? " is-active" : "";

  return `
    <a class="sponsor-slide${activeClass}" data-idx="${idx}" href="${linkUrl}" ${String(linkUrl).startsWith("http") ? 'target="_blank" rel="noopener"' : ""}>
      <img class="sponsor-slide-logo" src="${imageUrl}" alt="${title}" />
      <div class="sponsor-slide-copy">
        <strong>${title}</strong>
        <span>${subtitle}</span>
      </div>
    </a>`;
}
async function initSponsorRotator() {
  const root = $("sponsorRotator");
  const dotsWrap = $("sponsorDots");
  if (!root || !dotsWrap) return;

  const dbRows = await loadSponsorBannersFromDb();
  if (dbRows.length) {
    root.innerHTML = dbRows.map((r, i) => sponsorSlideHtml(r, i)).join("");
  }

  const slides = Array.from(root.querySelectorAll(".sponsor-slide"));
  if (!slides.length) return;

  let idx = 0;
  let timer = null;

  function renderDots() {
    dotsWrap.innerHTML = slides
      .map((_, i) => `<button type="button" class="sponsor-dot ${i === idx ? "is-active" : ""}" data-idx="${i}" aria-label="배너 ${i + 1}"></button>`)
      .join("");
  }

  function show(next) {
    idx = ((next % slides.length) + slides.length) % slides.length;
    slides.forEach((el, i) => el.classList.toggle("is-active", i === idx));
    dotsWrap.querySelectorAll(".sponsor-dot").forEach((el, i) => el.classList.toggle("is-active", i === idx));
  }

  function start() {
    stop();
    timer = setInterval(() => show(idx + 1), 4000);
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  dotsWrap.addEventListener("click", (e) => {
    const btn = e.target.closest(".sponsor-dot");
    if (!btn) return;
    const next = Number(btn.dataset.idx);
    if (Number.isFinite(next)) show(next);
  });

  root.addEventListener("mouseenter", stop);
  root.addEventListener("mouseleave", start);
  root.addEventListener("focusin", stop);
  root.addEventListener("focusout", start);

  renderDots();
  show(0);
  start();
}
function initUISlider() {
  // 기존 슬라이더 섹션이 없으면 아무 작업 안함
}

onAuthStateChanged(auth, async (user) => {
  const admin = await isAdmin(user?.uid);
  setupAdminUI(admin);

  // 레벨·지갑 주소 로드 (공유카드 레퍼럴 기능용)
  if (user?.uid) {
    try {
      const snap = await getDoc(doc(db, "users", user.uid));
      const data = snap.data() || {};
      _userWalletAddr = String(data.wallet?.address || "");
      // onChain 레벨은 Cloud Function으로 조회
      if (_userWalletAddr) {
        try {
          const fn = httpsCallable(functions, "getMyOnChain");
          const res = await fn();
          _userLevel = Number(res.data?.level || 0);
        } catch {
          // 레벨 조회 실패 시 0 유지
        }
      }
    } catch {
      // 유저 정보 조회 실패 시 무시
    }
  }
});

loadNotices();
initJackpotTicker();
loadJackpotWinners();
loadUsedMarketPreview();
loadMerchants();
loadCoopProducts();
initSponsorRotator().catch((e) => console.warn("sponsor init failed:", e));
initUISlider();
loadPlacesMap();

