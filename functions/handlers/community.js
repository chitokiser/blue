// functions/handlers/community.js
// 소셜 커뮤니티 행사 바우처 구매

'use strict';

const admin  = require('firebase-admin');
const { ethers } = require('ethers');
const { decrypt } = require('../wallet/crypto');
const {
  getProvider,
  getHexContract,
  getJumpBankContract,
  walletFromKey,
  getAdminWallet,
  estimateGasWithBuffer,
} = require('../wallet/chain');

const db = admin.firestore();

// ── 환율 캐시 ─────────────────────────────────────────────────
let _fxCache = { usdKrw: 0, ts: 0 };
const FX_TTL = 600_000;

async function fetchRates() {
  if (_fxCache.usdKrw > 0 && Date.now() - _fxCache.ts < FX_TTL) return _fxCache;
  try {
    const res  = await fetch('https://open.er-api.com/v6/latest/USD');
    const data = await res.json();
    _fxCache = {
      usdKrw: data?.rates?.KRW ?? 1370,
      usdVnd: data?.rates?.VND ?? 25000,
      ts: Date.now(),
    };
  } catch {
    _fxCache = { usdKrw: _fxCache.usdKrw || 1370, usdVnd: _fxCache.usdVnd || 25000, ts: Date.now() };
  }
  return _fxCache;
}

// VND → HEX wei (18 decimals)
function vndToHexWei(vndAmount, usdVnd) {
  // VND → USD → HEX
  // hexPriceWei: 1 JUMP 가격 (wei), 여기서는 1 HEX = 1 USD 기준 스케일 사용
  // 실제로는 HEX 자체가 USD 연동 토큰이므로: VND / usdVnd = USD 환산
  const usdAmt    = vndAmount / usdVnd;            // USD
  const hexAmount = usdAmt;                        // 1 HEX ≒ 1 USD (HEX 기준)
  // wei = hexAmount * 1e18
  const weiBig = BigInt(Math.round(hexAmount * 1e12)) * BigInt(1_000_000);
  return weiBig;
}

// ── 스테이킹 조회 ─────────────────────────────────────────────
async function getUserStaked(uid) {
  const userSnap = await db.collection('users').doc(uid).get();
  const address  = userSnap.data()?.wallet?.address;
  if (!address) return { staked: 0, address: null, walletData: userSnap.data()?.wallet };

  const jumpBank = getJumpBankContract(getProvider());
  const info     = await jumpBank.user(address);
  return {
    staked:     Number(info.depo),  // 0 decimals JUMP
    address,
    walletData: userSnap.data()?.wallet,
  };
}

// ── 바우처 구매 ───────────────────────────────────────────────
async function buyEventVoucher(uid, { eventId }, masterSecret) {
  if (!eventId) throw new Error('eventId가 필요합니다');

  // 1. 행사 조회
  const eventRef  = db.collection('community_events').doc(eventId);
  const eventSnap = await eventRef.get();
  if (!eventSnap.exists) throw new Error('행사를 찾을 수 없습니다');
  const event = eventSnap.data();

  // 2. 바우처 가격/수량 설정 확인
  if (!event.voucherPrice || event.voucherPrice <= 0) throw new Error('바우처 가격이 설정되지 않았습니다');
  const totalQty = event.voucherQty || 0;
  const soldQty  = event.voucherSold || 0;
  if (totalQty > 0 && soldQty >= totalQty) throw new Error('바우처가 모두 매진되었습니다');

  // 3. 중복 구매 확인
  const voucherRef = db.collection('community_event_vouchers').doc(`${uid}_${eventId}`);
  const existing   = await voucherRef.get();
  if (existing.exists) throw new Error('이미 이 행사의 바우처를 구매하셨습니다');

  // 4. 스테이킹 조건 확인
  const { staked, address, walletData } = await getUserStaked(uid);
  const required = event.stakeRequired || 0;
  if (staked < required) {
    throw new Error(
      `스테이킹 조건 미충족. 필요: BUT ${required.toLocaleString()}개, 보유: ${staked.toLocaleString()}개`
    );
  }

  if (!walletData?.encryptedKey) throw new Error('수탁 지갑이 없습니다');

  // 5. VND → HEX wei 환산
  const rates  = await fetchRates();
  const hexWei = vndToHexWei(event.voucherPrice, rates.usdVnd || 25000);

  // 6. HEX 잔액 확인
  const provider = getProvider();
  const hexRead  = getHexContract(provider);
  const hexBal   = await hexRead.balanceOf(address);
  if (hexBal < hexWei) {
    const have = parseFloat(ethers.formatEther(hexBal)).toFixed(4);
    const need = parseFloat(ethers.formatEther(hexWei)).toFixed(4);
    throw new Error(`HEX 잔액 부족. 필요: ${need} HEX, 보유: ${have} HEX`);
  }

  // 7. BNB 가스비 보충
  const adminWallet = getAdminWallet();
  const bnbBal = await provider.getBalance(address);
  if (bnbBal < ethers.parseEther('0.00005')) {
    const fundTx = await adminWallet.sendTransaction({
      to: address, value: ethers.parseEther('0.0001'),
    });
    await fundTx.wait();
  }

  // 8. HEX 전송 (수탁 지갑 → 관리자 지갑)
  const privateKey = decrypt(walletData.encryptedKey, masterSecret);
  const signer     = walletFromKey(privateKey, provider);
  const hexSigned  = getHexContract(signer);
  const gasLimit   = await estimateGasWithBuffer(hexSigned, 'transfer', [adminWallet.address, hexWei]);
  const tx         = await hexSigned.transfer(adminWallet.address, hexWei, { gasLimit });
  const receipt    = await tx.wait();
  const txHash     = receipt.hash;

  // 9. Firestore 기록
  const batch = db.batch();

  batch.set(voucherRef, {
    uid,
    eventId,
    eventName:   event.name || '',
    priceVnd:    event.voucherPrice,
    hexWei:      hexWei.toString(),
    txHash,
    staked,
    createdAt:   admin.firestore.FieldValue.serverTimestamp(),
  });

  batch.update(eventRef, {
    voucherSold: admin.firestore.FieldValue.increment(1),
  });

  await batch.commit();

  return {
    txHash,
    eventName:  event.name,
    priceVnd:   event.voucherPrice,
    amountHex:  parseFloat(ethers.formatEther(hexWei)).toFixed(4),
  };
}

// ── 내 바우처 조회 ────────────────────────────────────────────
async function getMyEventVoucher(uid, { eventId }) {
  const snap = await db.collection('community_event_vouchers').doc(`${uid}_${eventId}`).get();
  if (!snap.exists) return { voucher: null };
  return { voucher: snap.data() };
}

// ── 스테이킹 조건 체크 (프론트 노출용) ───────────────────────
async function checkEventEligibility(uid, { eventId }) {
  const eventSnap = await db.collection('community_events').doc(eventId).get();
  if (!eventSnap.exists) throw new Error('행사를 찾을 수 없습니다');
  const event = eventSnap.data();

  const { staked } = await getUserStaked(uid);
  const required   = event.stakeRequired || 0;
  const soldQty    = event.voucherSold   || 0;
  const totalQty   = event.voucherQty    || 0;

  const voucherSnap = await db.collection('community_event_vouchers')
    .doc(`${uid}_${eventId}`).get();

  return {
    staked,
    required,
    eligible:       staked >= required,
    alreadyBought:  voucherSnap.exists,
    remainingQty:   totalQty > 0 ? Math.max(0, totalQty - soldQty) : null,
    voucherPrice:   event.voucherPrice || 0,
    voucherQty:     totalQty,
    soldOut:        totalQty > 0 && soldQty >= totalQty,
    allowedSellers: event.allowedSellers || [],
  };
}

// ── 바우처 사용 확인 (판매자 호출) ───────────────────────────
async function confirmVoucher(uid, { voucherId }) {
  if (!voucherId) throw new Error('voucherId가 필요합니다');

  const vRef  = db.collection('community_event_vouchers').doc(voucherId);
  const vSnap = await vRef.get();
  if (!vSnap.exists) throw new Error('바우처를 찾을 수 없습니다');
  const voucher = vSnap.data();

  if (voucher.status === 'used') throw new Error('이미 사용된 바우처입니다');

  // 행사 정보
  const eSnap  = await db.collection('community_events').doc(voucher.eventId).get();
  const event  = eSnap.exists ? eSnap.data() : {};
  const sellers = event.allowedSellers || [];

  // 확인자 권한 검증: 관리자 또는 허용된 가맹점 소유자
  const isAdmin = await db.collection('admins').doc(uid).get().then(s => s.exists);
  if (!isAdmin && sellers.length > 0) {
    const userSnap = await db.collection('users').doc(uid).get();
    const merchantId = userSnap.data()?.merchantId;
    const allowed = sellers.some(s => (s.id || s) === merchantId);
    if (!allowed) throw new Error('사용 확인 권한이 없습니다');
  }

  // 확인자 정보
  const confirmerSnap = await db.collection('users').doc(uid).get();
  const merchantId    = confirmerSnap.data()?.merchantId || null;
  const confirmerName = confirmerSnap.data()?.displayName || uid;
  const settlementAmount = event.settlementAmount || 0;

  const batch = db.batch();

  // 바우처 상태 업데이트
  batch.update(vRef, {
    status:            'used',
    usedAt:            admin.firestore.FieldValue.serverTimestamp(),
    usedByUid:         uid,
    usedBySellerName:  confirmerName,
    usedByMerchantId:  merchantId,
    settlementStatus:  settlementAmount > 0 ? 'pending' : 'none',
    settlementAmount,
  });

  // 정산 레코드 생성
  if (settlementAmount > 0) {
    const settleRef = db.collection('community_voucher_settlements').doc();
    batch.set(settleRef, {
      voucherId,
      eventId:          voucher.eventId,
      eventName:        event.name || '',
      buyerUid:         voucher.uid,
      sellerUid:        uid,
      sellerName:       confirmerName,
      merchantId,
      settlementAmount,
      settlementStatus: 'pending',
      createdAt:        admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  await batch.commit();

  return { success: true, settlementAmount, confirmerName };
}

module.exports = {
  buyEventVoucher,
  getMyEventVoucher,
  checkEventEligibility,
  confirmVoucher,
};
