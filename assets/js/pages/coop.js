// /assets/js/pages/coop.js
// 조합전용몰 — 상품 목록 + 구매

import { auth, functions } from '../firebase-init.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js';
import { httpsCallable }      from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-functions.js';

const $ = (id) => document.getElementById(id);

function show(id, on) {
  const el = $(id);
  if (el) el.style.display = on ? '' : 'none';
}

// ─────────────────────────────────────────────────────────
// 로드 + 렌더
// ─────────────────────────────────────────────────────────
async function loadAndRender() {
  show('coopLoading', true);
  show('coopNeedLogin', false);
  show('coopDenied', false);
  show('coopMain', false);

  try {
    const fn  = httpsCallable(functions, 'listCoopProducts');
    const res = await fn();
    const { products, minStake, userStaked, hasAccess } = res.data;

    show('coopLoading', false);

    if (!hasAccess) {
      const pct = minStake > 0 ? Math.min(100, Math.round((userStaked / minStake) * 100)) : 0;
      const subEl = $('coopDeniedSub');
      if (subEl) subEl.textContent = `최소 ${minStake.toLocaleString()} BUT 스테이킹 필요`;
      const fillEl = $('coopStakeFill');
      if (fillEl) fillEl.style.width = pct + '%';
      const progEl = $('coopDeniedProgress');
      if (progEl) progEl.textContent = `현재 ${userStaked.toLocaleString()} / ${minStake.toLocaleString()} BUT`;
      show('coopDenied', true);
      return;
    }

    // 접근 가능 — 상품 그리드
    const badgeEl = $('coopAccessBadge');
    if (badgeEl) badgeEl.textContent = `회원 인증됨 (스테이킹 ${userStaked.toLocaleString()} BUT)`;

    const grid = $('coopGrid');
    if (products.length === 0) {
      show('coopEmpty', true);
    } else {
      grid.innerHTML = products.map(p => renderCard(p)).join('');
      grid.querySelectorAll('[data-detail]').forEach(btn => {
        btn.addEventListener('click', () => showDetailModal(btn.dataset.detail, products));
      });
    }
    show('coopMain', true);

  } catch (err) {
    show('coopLoading', false);
    $('coopLoading').textContent = '오류: ' + (err.message || '조회 실패');
    show('coopLoading', true);
  }
}

function renderCard(p) {
  const sold = p.stock === 0;
  const imgHtml = p.imageUrl
    ? `<img class="coop-card-img" src="${escHtml(p.imageUrl)}" alt="${escHtml(p.name)}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';">
       <div class="coop-card-img-ph" style="display:none;">🛍</div>`
    : `<div class="coop-card-img-ph">🛍</div>`;

  const stockTxt  = p.stock === -1 ? '' : sold ? '품절' : `재고 ${p.stock}개`;
  const stockCls  = sold ? 'out' : '';
  const typeBadge = p.type === 'voucher'
    ? `<span style="font-size:0.72rem;background:#fef3c7;color:#92400e;border-radius:99px;padding:1px 8px;display:inline-block;margin-bottom:4px;">바우처</span>`
    : `<span style="font-size:0.72rem;background:#e0e7ff;color:#3730a3;border-radius:99px;padding:1px 8px;display:inline-block;margin-bottom:4px;">일반상품</span>`;

  return `
    <div class="coop-card">
      ${imgHtml}
      <div class="coop-card-body">
        ${typeBadge}
        <div class="coop-card-name">${escHtml(p.name)}</div>
        ${p.description ? `<div class="coop-card-desc">${escHtml(p.description)}</div>` : ''}
        <div class="coop-card-price">${p.price.toLocaleString()}원</div>
        ${stockTxt ? `<div class="coop-card-stock ${stockCls}">${stockTxt}</div>` : ''}
        <button class="coop-btn-buy" data-detail="${p.id}" ${sold ? 'disabled' : ''}>
          ${sold ? '품절' : '상세보기'}
        </button>
      </div>
    </div>
  `;
}

function escHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─────────────────────────────────────────────────────────
// 상품 상세 모달
// ─────────────────────────────────────────────────────────
function showDetailModal(productId, products) {
  const p = products.find(x => x.id === productId);
  if (!p) return;

  const sold = p.stock === 0;

  // 이미지
  const imgEl = $('coopDetailImg');
  if (imgEl) {
    imgEl.innerHTML = p.imageUrl
      ? `<img class="coop-detail-img" src="${escHtml(p.imageUrl)}" alt="${escHtml(p.name)}" loading="lazy" onerror="this.outerHTML='<div class=\\'coop-detail-img-ph\\'>🛍</div>'">`
      : `<div class="coop-detail-img-ph">🛍</div>`;
  }

  // 배지
  const badgeEl = $('coopDetailBadge');
  if (badgeEl) {
    badgeEl.innerHTML = p.type === 'voucher'
      ? `<span style="font-size:0.75rem;background:#fef3c7;color:#92400e;border-radius:99px;padding:2px 10px;display:inline-block;margin-bottom:6px;">바우처</span>`
      : `<span style="font-size:0.75rem;background:#e0e7ff;color:#3730a3;border-radius:99px;padding:2px 10px;display:inline-block;margin-bottom:6px;">일반상품</span>`;
  }

  const nameEl  = $('coopDetailName');
  const descEl  = $('coopDetailDesc');
  const priceEl = $('coopDetailPrice');
  const stockEl = $('coopDetailStock');
  const buyBtn  = $('coopDetailBuyBtn');

  if (nameEl)  nameEl.textContent  = p.name || '';
  if (descEl)  { descEl.textContent = p.description || ''; descEl.style.display = p.description ? '' : 'none'; }
  if (priceEl) priceEl.textContent  = p.price.toLocaleString() + '원';

  if (stockEl) {
    const stockTxt = p.stock === -1 ? '' : sold ? '품절' : `재고 ${p.stock}개`;
    stockEl.textContent = stockTxt;
    stockEl.className = 'coop-detail-stock' + (sold ? ' out' : '');
  }

  if (buyBtn) {
    buyBtn.disabled   = sold;
    buyBtn.textContent = sold ? '품절' : '구매하기';
    buyBtn.onclick    = () => handleBuy(productId, products);
  }

  // 닫기 핸들러
  $('coopDetailBd').onclick    = closeDetailModal;
  $('coopDetailClose').onclick = closeDetailModal;

  // ESC 키
  const onKey = (e) => {
    if (e.key === 'Escape') { closeDetailModal(); window.removeEventListener('keydown', onKey); }
  };
  window.addEventListener('keydown', onKey);

  show('coopDetailModal', true);
}

function closeDetailModal() {
  show('coopDetailModal', false);
}

// ─────────────────────────────────────────────────────────
// 구매 처리
// ─────────────────────────────────────────────────────────
async function handleBuy(productId, products) {
  const product = products.find(p => p.id === productId);
  if (!product) return;

  if (!confirm(
    `${product.name}\n` +
    `가격: ${product.price.toLocaleString()}원\n` +
    `(수탁 지갑 HEX로 결제됩니다)\n\n` +
    `구매하시겠습니까?`
  )) return;

  const buyBtn = $('coopDetailBuyBtn');
  if (buyBtn) { buyBtn.disabled = true; buyBtn.textContent = '처리 중...'; }

  try {
    const fn  = httpsCallable(functions, 'buyCoopProduct');
    const res = await fn({ productId });
    closeDetailModal();
    showDoneModal(res.data);
  } catch (err) {
    alert('구매 실패: ' + (err?.message || '서버 오류'));
    if (buyBtn) { buyBtn.disabled = false; buyBtn.textContent = '구매하기'; }
  }
}

function showDoneModal(d) {
  const kvsEl = $('coopDoneKvs');
  if (kvsEl) {
    kvsEl.innerHTML = `
      <div class="coop-modal-kv"><span class="k">상품명</span><span class="v">${escHtml(d.productName)}</span></div>
      <div class="coop-modal-kv"><span class="k">결제금액</span><span class="v">${(d.priceKrw||0).toLocaleString()}원 (${d.amountHex||'?'} HEX)</span></div>
      <div class="coop-modal-kv"><span class="k">TxHash</span><span class="v" style="font-size:0.75em;">${(d.txHash||'').slice(0,22)}…</span></div>
    `;
  }
  show('coopDoneModal', true);
  $('coopModalBd').onclick    = closeModal;
  $('coopModalClose').onclick = closeModal;
}

function closeModal() {
  show('coopDoneModal', false);
  loadAndRender(); // 재고 반영 위해 새로고침
}

// ─────────────────────────────────────────────────────────
// 초기화
// ─────────────────────────────────────────────────────────
onAuthStateChanged(auth, (user) => {
  if (!user) {
    show('coopLoading', false);
    show('coopNeedLogin', true);
    return;
  }
  loadAndRender();
});
