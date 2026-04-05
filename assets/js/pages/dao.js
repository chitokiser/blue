// /assets/js/pages/dao.js
// JUMP DAO 의결 페이지 프론트엔드

import { initializeApp }       from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, onAuthStateChanged }
                                from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getFirestore, collection, query, orderBy, where, getDocs,
         doc, getDoc, onSnapshot, limit }
                                from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { getFunctions, httpsCallable }
                                from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js';
import { firebaseConfig }       from '/assets/js/firebase-config.js';
import { ethers }               from 'https://cdn.jsdelivr.net/npm/ethers@6.13.2/dist/ethers.min.js';

const app  = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db   = getFirestore(app);
const fns  = getFunctions(app);

// ── Firebase callable ───────────────────────────────────────────
const fnCreate        = httpsCallable(fns, 'daoCreateProposal');
const fnAdminApprove  = httpsCallable(fns, 'daoAdminApproveProposal');
const fnAdminReject   = httpsCallable(fns, 'daoAdminRejectProposal');
const fnUpdate        = httpsCallable(fns, 'daoUpdateProposal');
const fnDelete        = httpsCallable(fns, 'daoDeleteProposal');
const fnSupport       = httpsCallable(fns, 'daoSupportProposal');
const fnVote          = httpsCallable(fns, 'daoVoteProposal');
const fnComment       = httpsCallable(fns, 'daoCommentProposal');

// ── 온체인 스테이킹 조회 ─────────────────────────────────────────
const OPBNB_RPC     = 'https://opbnb-mainnet-rpc.bnbchain.org';
const JUMP_BANK     = '0x7a310060BcE6e5C66d8eb47E19Ea50CefB963a33'; // butBank
const BANK_ABI      = [
  'function user(address who) external view returns (uint256 totalAllow, uint256 totalBuy, uint256 depo, uint256 stakingTime, uint256 lastClaim)',
  'function totalStaked() external view returns (uint256)',
];

let _provider = null;
let _bank     = null;
function getBank() {
  if (!_bank) {
    _provider = new ethers.JsonRpcProvider(OPBNB_RPC);
    _bank = new ethers.Contract(JUMP_BANK, BANK_ABI, _provider);
  }
  return _bank;
}

async function getMyStaked(walletAddress) {
  try {
    const info = await getBank().user(walletAddress);
    return Number(info[2]);
  } catch { return 0; }
}

async function getTotalStaked() {
  try {
    return Number(await getBank().totalStaked());
  } catch { return 0; }
}

// ── 상태 ────────────────────────────────────────────────────────
let currentUser    = null;
let myWallet       = null;
let myStaked       = 0;
let isAdmin        = false;
let currentFilter  = 'all';
let currentProposal = null;
let unsubComments  = null;

const $ = id => document.getElementById(id);

// ── 초기화 ──────────────────────────────────────────────────────
onAuthStateChanged(auth, async user => {
  currentUser = user;

  // currentUser 확정 즉시 상세 뷰 액션 갱신 (await 전에 실행)
  if (currentProposal && $('daoDetailView').classList.contains('open')) {
    renderActions(currentProposal.id, currentProposal);
  }

  if (user) {
    // await 전에 먼저 버튼 표시 — Firestore 에러와 무관하게 즉시 활성화
    $('btnCreateProposal').style.display = 'inline-flex';

    try {
      const snap = await getDoc(doc(db, 'users', user.uid));
      myWallet = snap.data()?.wallet?.address || null;
    } catch { myWallet = null; }

    if (myWallet) {
      try { myStaked = await getMyStaked(myWallet); } catch { myStaked = 0; }
    }

    try {
      const adminSnap = await getDoc(doc(db, 'admins', user.uid));
      isAdmin = adminSnap.exists();
    } catch { isAdmin = false; }
  } else {
    myWallet = null; myStaked = 0; isAdmin = false;
    $('btnCreateProposal').style.display = 'none';
  }

  // staking/admin 정보 로드 후 상세 뷰 재갱신 (스테이킹 수량 반영)
  if (currentProposal && $('daoDetailView').classList.contains('open')) {
    renderActions(currentProposal.id, currentProposal);
  }

  loadProposals();
});

// ── 탭 ─────────────────────────────────────────────────────────
$('daoTabs').addEventListener('click', e => {
  const tab = e.target.closest('.dao-tab');
  if (!tab) return;
  document.querySelectorAll('.dao-tab').forEach(t => t.classList.remove('active'));
  tab.classList.add('active');
  currentFilter = tab.dataset.status;
  loadProposals();
});

// ── 안건 등록 모달 ───────────────────────────────────────────────
$('btnCreateProposal').addEventListener('click', () => {
  $('createModal').classList.add('open');
  $('createMsg').textContent = '';
  $('proposalTitle').value   = '';
  $('proposalContent').value = '';
});
$('btnCreateCancel').addEventListener('click', () => $('createModal').classList.remove('open'));
$('createModal').addEventListener('click', e => {
  if (e.target === $('createModal')) $('createModal').classList.remove('open');
});

$('btnCreateSubmit').addEventListener('click', async () => {
  const title   = $('proposalTitle').value.trim();
  const content = $('proposalContent').value.trim();
  const btn     = $('btnCreateSubmit');

  if (!title)   { $('createMsg').textContent = '제목을 입력해주세요'; return; }
  if (!content) { $('createMsg').textContent = '내용을 입력해주세요'; return; }
  if (!currentUser && !auth.currentUser) { $('createMsg').textContent = '로그인이 필요합니다'; return; }
  if (!currentUser) currentUser = auth.currentUser;

  btn.disabled = true;
  btn.textContent = '등록 중...';
  $('createMsg').textContent = '';

  try {
    await fnCreate({ title, content });
    $('createModal').classList.remove('open');
    loadProposals();
    alert('안건이 등록되었습니다. 관리자 승인 후 심의가 시작됩니다.');
  } catch (err) {
    $('createMsg').textContent = err.message || '등록 실패';
  } finally {
    btn.disabled = false;
    btn.textContent = '등록하기';
  }
});

// ── 목록 로드 ───────────────────────────────────────────────────
async function loadProposals() {
  const list = $('daoList');
  list.innerHTML = '<div class="dao-empty"><div class="dao-empty-icon">⏳</div><div class="dao-empty-text">불러오는 중...</div></div>';

  try {
    let q;
    if (currentFilter === 'all') {
      q = query(collection(db, 'dao_proposals'), orderBy('createdAt', 'desc'), limit(100));
    } else {
      q = query(collection(db, 'dao_proposals'), where('status', '==', currentFilter), limit(100));
    }

    const snap = await getDocs(q);
    const docs = currentFilter === 'all'
      ? snap.docs
      : snap.docs.sort((a, b) => {
          const ta = a.data().createdAt?.seconds ?? 0;
          const tb = b.data().createdAt?.seconds ?? 0;
          return tb - ta;
        });

    $('daoCount').textContent = `총 ${docs.length}건`;

    if (docs.length === 0) {
      list.innerHTML = '<div class="dao-empty"><div class="dao-empty-icon">📋</div><div class="dao-empty-text">등록된 안건이 없습니다</div></div>';
      return;
    }

    list.innerHTML = '';
    docs.forEach(d => {
      const data = d.data();
      list.appendChild(renderCard(d.id, data));
    });
  } catch (err) {
    list.innerHTML = `<div class="dao-empty"><div class="dao-empty-text">불러오기 실패: ${err.message}</div></div>`;
  }
}

function renderCard(id, data) {
  const div = document.createElement('div');
  div.className = 'dao-card';
  div.innerHTML = `
    <div class="dao-card-top">
      <div class="dao-card-title">${escHtml(data.title)}</div>
      <span class="dao-badge ${badgeClass(data.status)}">${statusLabel(data.status)}</span>
    </div>
    <div class="dao-card-meta">
      <span>👤 ${shortAddr(data.authorWallet)}</span>
      <span>📅 ${fmtDate(data.createdAt)}</span>
      ${data.status === 'review'  ? `<span>👍 지지 ${num(data.supportStaked)} JUMP / 250,000</span>` : ''}
      ${['voting','passed','rejected'].includes(data.status) ? `<span>🗳️ 찬성 ${data.voteYes||0} · 반대 ${data.voteNo||0}</span>` : ''}
    </div>
  `;
  div.addEventListener('click', () => openDetail(id, data));
  return div;
}

// ── 상세 뷰 ─────────────────────────────────────────────────────
async function openDetail(id, data) {
  currentProposal = { id, ...data };

  // 뷰 전환
  $('daoListView').style.display  = 'none';
  $('daoDetailView').classList.add('open');

  // 기본 정보
  $('detailBadge').className  = `dao-badge ${badgeClass(data.status)}`;
  $('detailBadge').textContent = statusLabel(data.status);
  $('detailTitle').textContent = data.title;
  $('detailBody').textContent  = data.content;
  $('detailMeta').innerHTML = `
    <span>👤 ${shortAddr(data.authorWallet)}</span>
    <span>📅 ${fmtDate(data.createdAt)}</span>
    <span>💎 등록 시 스테이킹: ${num(data.authorStaked)} JUMP</span>
  `;

  // 지지 현황
  const supportEl = $('supportProgress');
  if (data.status === 'review') {
    supportEl.style.display = '';
    const pct = Math.min(100, ((data.supportStaked || 0) / 250000) * 100);
    $('supportBar').style.width = pct + '%';
    $('supportYes').textContent  = `${num(data.supportStaked || 0)} JUMP`;
  } else {
    supportEl.style.display = 'none';
  }

  // 투표 현황
  const voteEl = $('voteProgress');
  if (['voting','passed','rejected'].includes(data.status)) {
    voteEl.style.display = '';
    const yes = data.voteYesStaked || 0;
    const no  = data.voteNoStaked  || 0;
    const total = yes + no;
    const pct = total > 0 ? Math.round((yes / total) * 100) : 0;
    $('voteBar').style.width     = pct + '%';
    $('voteYesLabel').textContent = `찬성 ${data.voteYes||0}표 (${num(yes)} JUMP)`;
    $('voteNoLabel').textContent  = `반대 ${data.voteNo||0}표 (${num(no)} JUMP)`;

    const totalStaked = await getTotalStaked();
    if (totalStaked > 0) {
      const majority = Math.floor(totalStaked / 2);
      $('voteQuorum').textContent = `과반 기준: ${num(majority)} JUMP (전체 스테이킹 ${num(totalStaked)} JUMP의 50%)`;
    }
  } else {
    voteEl.style.display = 'none';
  }

  // 액션 버튼
  renderActions(id, data);

  // 수정/삭제 버튼
  // - 관리자: 모든 상태에서 가능
  // - 작성자: pending_admin 상태만 가능
  const sameWallet = myWallet && data.authorWallet &&
    data.authorWallet.toLowerCase() === myWallet.toLowerCase();
  const sameUid = currentUser && data.authorUid === currentUser.uid;
  const isAuthor = currentUser && (sameWallet || sameUid);
  const canEdit = currentUser && (isAdmin || (isAuthor && data.status === 'pending_admin'));
  const editBtnWrap = $('editBtnWrap');
  if (editBtnWrap) {
    editBtnWrap.style.display = canEdit ? 'flex' : 'none';
    if (canEdit) {
      $('btnEditProposal').onclick   = () => openEditModal(id, data);
      $('btnDeleteProposal').onclick = () => doDeleteProposal(id);
    }
  }

  // 관리자 패널
  const adminEl = $('adminActions');
  if (isAdmin && data.status === 'pending_admin') {
    adminEl.style.display = '';
    $('btnAdminApprove').onclick = () => adminAction(id, 'approve');
    $('btnAdminReject').onclick  = () => adminAction(id, 'reject');
  } else {
    adminEl.style.display = 'none';
  }

  // 댓글
  $('commentsSection').style.display = '';
  loadComments(id);

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function renderActions(id, data) {
  const el = $('daoActions');
  el.innerHTML = '';

  if (!currentUser) {
    el.style.display = '';
    const hint = document.createElement('span');
    hint.className = 'hint';
    hint.textContent = '로그인 후 참여할 수 있습니다';
    el.appendChild(hint);
    return;
  }

  if (data.status === 'review') {
    el.style.display = '';
    const btn = mkBtn('👍 지지하기', 'btn--primary');
    btn.onclick = () => doSupport(id);
    el.appendChild(btn);
    const hint = document.createElement('span');
    hint.className = 'hint';
    hint.textContent = `내 스테이킹: ${num(myStaked)} JUMP · 지지하면 내 스테이킹 수량이 누적됩니다`;
    el.appendChild(hint);
    return;
  }

  if (data.status === 'voting') {
    el.style.display = '';
    const yes = mkBtn('👍 찬성', 'btn--primary');
    const no  = mkBtn('👎 반대', '');
    no.style.cssText = 'background:#fee2e2;color:#991b1b;border-color:#fca5a5;';
    yes.onclick = () => doVote(id, 'yes');
    no.onclick  = () => doVote(id, 'no');
    el.appendChild(yes);
    el.appendChild(no);
    const hint = document.createElement('span');
    hint.className = 'hint';
    hint.textContent = `내 스테이킹: ${num(myStaked)} JUMP (1개 이상 필요) · 중복 투표 불가`;
    el.appendChild(hint);
    return;
  }

  el.style.display = 'none';
}

function mkBtn(text, cls) {
  const b = document.createElement('button');
  b.className = `btn ${cls} btn--sm`;
  b.textContent = text;
  return b;
}

// ── 지지 ───────────────────────────────────────────────────────
async function doSupport(proposalId) {
  if (!currentUser) { alert('로그인이 필요합니다'); return; }
  if (!confirm('이 안건을 지지하시겠습니까? (중복 지지 불가)')) return;

  try {
    const result = await fnSupport({ proposalId });
    if (result.data?.promoted) {
      alert('지지 완료! 25만 JUMP 달성으로 의결 단계로 전환되었습니다 🎉');
    } else {
      alert('지지가 완료되었습니다');
    }
    // 최신 데이터 다시 로드
    const snap = await getDoc(doc(db, 'dao_proposals', proposalId));
    openDetail(proposalId, snap.data());
  } catch (err) {
    alert(err.message || '지지 실패');
  }
}

// ── 투표 ───────────────────────────────────────────────────────
async function doVote(proposalId, vote) {
  if (!currentUser) { alert('로그인이 필요합니다'); return; }
  const label = vote === 'yes' ? '찬성' : '반대';
  if (!confirm(`"${label}"으로 투표하시겠습니까? (중복 투표 불가)`)) return;

  try {
    await fnVote({ proposalId, vote });
    alert('투표가 완료되었습니다');
    const snap = await getDoc(doc(db, 'dao_proposals', proposalId));
    openDetail(proposalId, snap.data());
  } catch (err) {
    alert(err.message || '투표 실패');
  }
}

// ── 안건 수정 ────────────────────────────────────────────────────
function openEditModal(proposalId, data) {
  $('editTitle').value   = data.title   || '';
  $('editContent').value = data.content || '';
  $('editMsg').textContent = '';
  const desc = $('editModalDesc');
  if (desc) {
    desc.textContent = isAdmin && data.status !== 'pending_admin'
      ? `관리자 모드: [${statusLabel(data.status)}] 상태 안건을 수정합니다.`
      : '승인 대기 중인 안건의 제목과 내용을 수정할 수 있습니다.';
  }
  $('editModal').classList.add('open');

  $('btnEditSubmit').onclick = async () => {
    const title   = $('editTitle').value.trim();
    const content = $('editContent').value.trim();
    const btn     = $('btnEditSubmit');

    if (!title)   { $('editMsg').textContent = '제목을 입력해주세요'; return; }
    if (!content) { $('editMsg').textContent = '내용을 입력해주세요'; return; }

    btn.disabled = true;
    btn.textContent = '저장 중...';
    $('editMsg').textContent = '';

    try {
      await fnUpdate({ proposalId, title, content });
      $('editModal').classList.remove('open');
      // 상세 뷰 갱신
      const snap = await getDoc(doc(db, 'dao_proposals', proposalId));
      openDetail(proposalId, snap.data());
    } catch (err) {
      $('editMsg').textContent = err.message || '수정 실패';
    } finally {
      btn.disabled = false;
      btn.textContent = '저장하기';
    }
  };
}

async function doDeleteProposal(proposalId) {
  if (!confirm('이 안건을 삭제하시겠습니까?\n삭제 후 복구할 수 없습니다.')) return;
  try {
    await fnDelete({ proposalId });
    alert('안건이 삭제되었습니다.');
    // 목록으로 돌아가기
    if (unsubComments) { unsubComments(); unsubComments = null; }
    $('daoDetailView').classList.remove('open');
    $('daoListView').style.display = '';
    currentProposal = null;
    loadProposals();
  } catch (err) {
    alert(err.message || '삭제 실패');
  }
}

$('btnEditCancel').addEventListener('click', () => $('editModal').classList.remove('open'));
$('editModal').addEventListener('click', e => {
  if (e.target === $('editModal')) $('editModal').classList.remove('open');
});

// ── 관리자 액션 ─────────────────────────────────────────────────
async function adminAction(proposalId, action) {
  if (action === 'approve') {
    if (!confirm('이 안건을 승인하여 심의 단계로 전환하시겠습니까?')) return;
    try {
      await fnAdminApprove({ proposalId });
      alert('승인 완료. 심의 단계로 전환되었습니다');
      const snap = await getDoc(doc(db, 'dao_proposals', proposalId));
      openDetail(proposalId, snap.data());
    } catch (err) {
      alert(err.message || '승인 실패');
    }
  } else {
    if (!confirm('이 안건을 반려하시겠습니까?')) return;
    const reason = prompt('반려 사유를 입력하세요 (선택, 빈 칸도 가능):') ?? '';
    try {
      await fnAdminReject({ proposalId, reason });
      alert('반려 처리되었습니다');
      const snap = await getDoc(doc(db, 'dao_proposals', proposalId));
      openDetail(proposalId, snap.data());
    } catch (err) {
      alert(err.message || '반려 실패');
    }
  }
}

// ── 댓글 ───────────────────────────────────────────────────────
function loadComments(proposalId) {
  if (unsubComments) { unsubComments(); unsubComments = null; }

  const q = query(
    collection(db, 'dao_proposals', proposalId, 'comments'),
    orderBy('createdAt', 'asc'),
    limit(200)
  );

  unsubComments = onSnapshot(q, snap => {
    $('commentCount').textContent = `(${snap.docs.length})`;
    const list = $('commentList');
    list.innerHTML = '';
    if (snap.empty) {
      list.innerHTML = '<div style="color:var(--muted);font-size:0.85rem;text-align:center;padding:20px 0;">첫 번째 댓글을 남겨보세요</div>';
      return;
    }
    snap.docs.forEach(d => {
      const c = d.data();
      const el = document.createElement('div');
      el.className = 'dao-comment-item';
      el.innerHTML = `
        <div class="dao-comment-meta">
          <span>${shortAddr(c.wallet)}</span>
          <span>${fmtDate(c.createdAt)}</span>
          <span>💎 ${num(c.staked)} JUMP</span>
        </div>
        <div class="dao-comment-body">${escHtml(c.content)}</div>
      `;
      list.appendChild(el);
    });
  });
}

$('btnComment').addEventListener('click', async () => {
  const content = $('commentInput').value.trim();
  const msg     = $('commentMsg');
  const btn     = $('btnComment');
  if (!content) { msg.textContent = '댓글 내용을 입력해주세요'; return; }
  if (!currentUser) { msg.textContent = '로그인이 필요합니다'; return; }
  if (!currentProposal) return;

  btn.disabled = true;
  msg.textContent = '';

  try {
    await fnComment({ proposalId: currentProposal.id, content });
    $('commentInput').value = '';
  } catch (err) {
    msg.textContent = err.message || '댓글 등록 실패';
  } finally {
    btn.disabled = false;
  }
});

// ── 목록으로 돌아가기 ────────────────────────────────────────────
$('btnDaoBack').addEventListener('click', () => {
  if (unsubComments) { unsubComments(); unsubComments = null; }
  $('daoDetailView').classList.remove('open');
  $('daoListView').style.display = '';
  currentProposal = null;
  loadProposals();
});

// ── 유틸 ────────────────────────────────────────────────────────
function statusLabel(s) {
  return { pending_admin: '승인 대기', review: '심의 중', voting: '의결 중', passed: '통과', rejected: '부결/반려' }[s] || s;
}
function badgeClass(s) {
  return { pending_admin: 'badge-pending', review: 'badge-review', voting: 'badge-voting', passed: 'badge-passed', rejected: 'badge-rejected' }[s] || '';
}
function shortAddr(addr) {
  if (!addr) return '-';
  return addr.slice(0, 6) + '...' + addr.slice(-4);
}
function fmtDate(ts) {
  if (!ts) return '-';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString('ko-KR', { year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' });
}
function num(n) {
  return (n || 0).toLocaleString();
}
function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
