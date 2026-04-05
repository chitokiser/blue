// functions/handlers/coop.js
// 조합전용몰 — 접근 확인 / 상품 목록 / 구매 / 관리자 설정

'use strict';

const admin = require('firebase-admin');
const { ethers } = require('ethers');
const { decrypt } = require('../wallet/crypto');
const {
  getProvider,
  getHexContract,
  getButBankContract,
  getJumpBankContract,
  walletFromKey,
  getAdminWallet,
  estimateGasWithBuffer,
} = require('../wallet/chain');
const { requireAdmin } = require('../wallet/admin');

const db = admin.firestore();

// ─────────────────────────────────────────────
// 환율 (KRW → HEX wei)
// ─────────────────────────────────────────────
let _fxCache = { rate: 0, ts: 0 };
const FX_TTL_MS = 600_000;

async function fetchUsdKrwRate() {
  if (_fxCache.rate > 0 && Date.now() - _fxCache.ts < FX_TTL_MS) return _fxCache.rate;
  try {
    const res  = await fetch('https://open.er-api.com/v6/latest/USD');
    const data = await res.json();
    const rate = data?.rates?.KRW ?? 0;
    if (rate > 0) _fxCache = { rate, ts: Date.now() };
    return rate;
  } catch {
    return _fxCache.rate || 1370;
  }
}

function krwToHexWei(krwAmount, krwPerUsd) {
  const krwScaled  = BigInt(Math.round(krwAmount * 10000));
  const rateScaled = BigInt(Math.round(krwPerUsd * 10000));
  return (krwScaled * (10n ** 18n)) / rateScaled;
}

// ─────────────────────────────────────────────
// 내부 헬퍼: 접근 권한 확인
// ─────────────────────────────────────────────
async function getCoopAccess(uid) {
  const configSnap = await db.collection('coopConfig').doc('main').get();
  const minStake   = configSnap.exists ? (configSnap.data()?.minStake ?? 10000) : 10000;

  const userSnap = await db.collection('users').doc(uid).get();
  const address  = userSnap.data()?.wallet?.address || null;

  let userStaked = 0;
  if (address) {
    try {
      const butBank = getButBankContract(getProvider());
      const userInfo = await butBank.user(address);
      userStaked     = Number(userInfo.depo);
    } catch (_) {}
  }

  return { minStake, userStaked, hasAccess: userStaked >= minStake };
}

// ─────────────────────────────────────────────
// 1. 상품 목록 조회 (접근 여부 포함)
// ─────────────────────────────────────────────
async function listCoopProducts(uid) {
  const access = await getCoopAccess(uid);

  const snap = await db.collection('coopProducts')
    .where('active', '==', true)
    .get();

  const products = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));

  return {
    products,
    minStake:   access.minStake,
    userStaked: access.userStaked,
    hasAccess:  access.hasAccess,
  };
}

// ─────────────────────────────────────────────
// 2. 상품 구매
// ─────────────────────────────────────────────
async function buyCoopProduct(uid, { productId }, masterSecret) {
  const access = await getCoopAccess(uid);
  if (!access.hasAccess) {
    throw new Error(
      `스테이킹 부족. 최소 ${access.minStake.toLocaleString()}개 필요, ` +
      `현재 ${access.userStaked.toLocaleString()}개`
    );
  }

  const productSnap = await db.collection('coopProducts').doc(productId).get();
  if (!productSnap.exists) throw new Error('상품이 존재하지 않습니다');
  const product = productSnap.data();
  if (!product.active)    throw new Error('판매 중인 상품이 아닙니다');
  if (product.stock === 0) throw new Error('품절된 상품입니다');

  const usdKrwRate = await fetchUsdKrwRate();
  const hexWei     = krwToHexWei(product.price, usdKrwRate || 1370);

  const userSnap   = await db.collection('users').doc(uid).get();
  const walletData = userSnap.data()?.wallet;
  if (!walletData?.encryptedKey) throw new Error('수탁 지갑이 없습니다');

  const provider = getProvider();
  const hexRead  = getHexContract(provider);
  const hexBal   = await hexRead.balanceOf(walletData.address);
  if (hexBal < hexWei) {
    const have = parseFloat(ethers.formatEther(hexBal)).toFixed(4);
    const need = parseFloat(ethers.formatEther(hexWei)).toFixed(4);
    throw new Error(`HEX 잔액 부족. 필요: ${need} HEX, 보유: ${have} HEX`);
  }

  // BNB 가스비 보충
  const adminWallet = getAdminWallet();
  const bnbBal = await provider.getBalance(walletData.address);
  if (bnbBal < ethers.parseEther('0.00005')) {
    const fundTx = await adminWallet.sendTransaction({
      to: walletData.address, value: ethers.parseEther('0.0001'),
    });
    await fundTx.wait();
  }

  // HEX 전송 (수탁 지갑 → 관리자 지갑)
  const privateKey = decrypt(walletData.encryptedKey, masterSecret);
  const signer     = walletFromKey(privateKey, provider);
  const hexSigned  = getHexContract(signer);
  const gasLimit   = await estimateGasWithBuffer(hexSigned, 'transfer', [adminWallet.address, hexWei]);
  const tx         = await hexSigned.transfer(adminWallet.address, hexWei, { gasLimit });
  const receipt    = await tx.wait();
  const txHash     = receipt.hash;

  const batch = db.batch();

  batch.set(db.collection('coopOrders').doc(), {
    uid,
    productId,
    productName: product.name,
    priceKrw:    product.price,
    hexWei:      hexWei.toString(),
    txHash,
    status:      'confirmed',
    createdAt:   admin.firestore.FieldValue.serverTimestamp(),
  });

  if (product.stock > 0) {
    batch.update(db.collection('coopProducts').doc(productId), {
      stock: admin.firestore.FieldValue.increment(-1),
    });
  }

  await batch.commit();

  return {
    txHash,
    productName: product.name,
    priceKrw:    product.price,
    hexWei:      hexWei.toString(),
    amountHex:   parseFloat(ethers.formatEther(hexWei)).toFixed(4),
  };
}

// ─────────────────────────────────────────────
// 3. 관리자: 설정 변경
// ─────────────────────────────────────────────
async function adminSetCoopConfig(uid, { minStake }) {
  await requireAdmin(uid);
  const val = Number(minStake);
  if (!Number.isFinite(val) || val < 0) throw new Error('유효하지 않은 minStake 값');
  await db.collection('coopConfig').doc('main').set({
    minStake: val,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedBy: uid,
  });
  return { minStake: val };
}

// ─────────────────────────────────────────────
// 4. 관리자: 상품 등록/수정
// ─────────────────────────────────────────────
async function adminSaveCoopProduct(uid, data) {
  await requireAdmin(uid);
  const { id, type, name, description, price, imageUrl, stock, active } = data;
  if (!name || !String(name).trim()) throw new Error('상품명이 필요합니다');
  const priceNum = Number(price);
  if (!Number.isFinite(priceNum) || priceNum <= 0) throw new Error('유효하지 않은 가격');
  const stockNum = Number(stock);
  if (!Number.isFinite(stockNum) || stockNum < -1) throw new Error('유효하지 않은 재고 (-1=무제한)');
  const typeVal  = type === 'voucher' ? 'voucher' : 'general';

  const docData = {
    type:        typeVal,
    name:        String(name).trim(),
    description: description ? String(description).trim() : '',
    price:       Math.round(priceNum),
    imageUrl:    imageUrl    ? String(imageUrl).trim()    : '',
    stock:       Math.round(stockNum),
    active:      active !== false,
    updatedAt:   admin.firestore.FieldValue.serverTimestamp(),
    updatedBy:   uid,
  };

  if (id) {
    await db.collection('coopProducts').doc(id).update(docData);
    return { id };
  }
  docData.createdAt = admin.firestore.FieldValue.serverTimestamp();
  docData.createdBy = uid;
  const ref = await db.collection('coopProducts').add(docData);
  return { id: ref.id };
}

// ─────────────────────────────────────────────
// 5. 관리자: 상품 삭제
// ─────────────────────────────────────────────
async function adminDeleteCoopProduct(uid, { id }) {
  await requireAdmin(uid);
  if (!id) throw new Error('상품 ID가 필요합니다');
  await db.collection('coopProducts').doc(id).delete();
  return { id };
}

module.exports = {
  listCoopProducts,
  buyCoopProduct,
  adminSetCoopConfig,
  adminSaveCoopProduct,
  adminDeleteCoopProduct,
};
