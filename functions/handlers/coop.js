// functions/handlers/coop.js
// 조합전용몰 — 접근 확인 / 상품 목록 / 구매 / 관리자 설정

'use strict';

const admin = require('firebase-admin');
const { ethers } = require('ethers');
const { decrypt } = require('../wallet/crypto');
const {
  ADDRESSES,
  getProvider,
  getHexContract,
  getHexTokenContract,
  getButBankContract,
  getJumpBankContract,
  getPlatformContract,
  getCoopMallContract,
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
// 내부 헬퍼: 접근 권한 확인 (CoopMall 온체인 멤버십)
// ─────────────────────────────────────────────
async function getCoopAccess(uid) {
  const userSnap = await db.collection('users').doc(uid).get();
  const address  = userSnap.data()?.wallet?.address || null;

  let isMember         = false;
  let membershipFeeWei = '10000000000000000000'; // 10 HEX (기본값)
  let userPoints       = '0';

  if (address) {
    try {
      const provider  = getProvider();
      const coopMall  = getCoopMallContract(provider);
      const [userInfo, feeWei] = await Promise.all([
        coopMall.users(address),
        coopMall.membershipFeeHex(),
      ]);
      isMember         = userInfo.member;
      membershipFeeWei = feeWei.toString();
      userPoints       = userInfo.points.toString();
    } catch (_) {}
  }

  // 수탁 지갑이 있으면 누구든 가입 가능 (자격 부여 자동화)
  const canJoin = !!address;

  return { isMember, canJoin, membershipFeeWei, hasAccess: isMember, address, userPoints };
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
    hasAccess:        access.hasAccess,
    isMember:         access.isMember,
    canJoin:          access.canJoin,
    membershipFeeWei: access.membershipFeeWei,
    userPoints:       access.userPoints,
  };
}

// ─────────────────────────────────────────────
// 2. 상품 구매
// ─────────────────────────────────────────────
async function buyCoopProduct(uid, { productId }, masterSecret) {
  const access = await getCoopAccess(uid);
  if (!access.hasAccess) {
    throw new Error('CoopMall 회원이 아닙니다. 10 HEX 회비를 납부하고 가입하세요.');
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

// ─────────────────────────────────────────────
// 6. CoopMall 가입 (누구나 직접 10 HEX 납부)
//    - 관리자 승인 없이 자동 처리
//    - 멘토는 butPlatform.members(addr).mentor 에서 자동 조회
// ─────────────────────────────────────────────
async function joinCoopMall(uid, masterSecret) {
  const userSnap = await db.collection('users').doc(uid).get();
  const walletData = userSnap.data()?.wallet;
  if (!walletData?.encryptedKey) throw new Error('수탁 지갑이 없습니다');

  const userAddr  = walletData.address;
  const provider  = getProvider();
  const coopMall  = getCoopMallContract(provider);
  const mallInfo  = await coopMall.users(userAddr);

  if (mallInfo.member) throw new Error('이미 CoopMall 회원입니다');

  // butPlatform 에서 멘토 주소 조회
  let mentorAddr = ethers.ZeroAddress;
  try {
    const platform   = getPlatformContract(provider);
    const memberInfo = await platform.members(userAddr);
    const candidate  = memberInfo.mentor;
    // 자기 자신이 멘토인 경우(불가) → address(0) 사용
    if (candidate && candidate.toLowerCase() !== userAddr.toLowerCase()) {
      mentorAddr = candidate;
    }
  } catch (_) {}

  const feeWei   = await coopMall.membershipFeeHex();
  const hexToken = getHexTokenContract(provider);
  const hexBal   = await hexToken.balanceOf(userAddr);
  if (hexBal < feeWei) {
    const have = parseFloat(ethers.formatEther(hexBal)).toFixed(4);
    const need = parseFloat(ethers.formatEther(feeWei)).toFixed(4);
    throw new Error(`HEX 잔액 부족. 필요: ${need} HEX, 보유: ${have} HEX`);
  }

  // 관리자 지갑으로 grantEligibility 자동 실행 (아직 eligible 아닌 경우)
  const adminWallet = getAdminWallet();
  if (!mallInfo.eligible) {
    const mallAdmin  = getCoopMallContract(adminWallet);
    const grantGas   = await estimateGasWithBuffer(mallAdmin, 'grantEligibility', [userAddr, mentorAddr]);
    const grantTx    = await mallAdmin.grantEligibility(userAddr, mentorAddr, { gasLimit: grantGas });
    await grantTx.wait();
  }

  // BNB 가스비 보충 (유저 수탁 지갑)
  const bnbBal = await provider.getBalance(userAddr);
  if (bnbBal < ethers.parseEther('0.0001')) {
    const fundTx = await adminWallet.sendTransaction({
      to: userAddr, value: ethers.parseEther('0.0002'),
    });
    await fundTx.wait();
  }

  const privateKey  = decrypt(walletData.encryptedKey, masterSecret);
  const signer      = walletFromKey(privateKey, provider);
  const hexSigned   = getHexTokenContract(signer);
  const mallAddress = ADDRESSES.coopMall;

  // HEX approve
  const approvGas = await estimateGasWithBuffer(hexSigned, 'approve', [mallAddress, feeWei]);
  const approvTx  = await hexSigned.approve(mallAddress, feeWei, { gasLimit: approvGas });
  await approvTx.wait();

  // joinMall
  const mallSigned = getCoopMallContract(signer);
  const joinGas    = await estimateGasWithBuffer(mallSigned, 'joinMall', []);
  const joinTx     = await mallSigned.joinMall({ gasLimit: joinGas });
  const receipt    = await joinTx.wait();

  return {
    txHash:    receipt.hash,
    feeHex:    parseFloat(ethers.formatEther(feeWei)).toFixed(4),
    mentor:    mentorAddr,
  };
}

// ─────────────────────────────────────────────
// 7. 포인트 → HEX 전환
//    - CoopMall.convertPoints(pts) 호출
//    - 전환 가능한 포인트 전액을 HEX로 출금
// ─────────────────────────────────────────────
async function convertCoopPoints(uid, masterSecret) {
  const access = await getCoopAccess(uid);
  if (!access.hasAccess) throw new Error('CoopMall 회원이 아닙니다');

  const pts = BigInt(access.userPoints);
  if (pts === 0n) throw new Error('전환 가능한 포인트가 없습니다');

  const userSnap   = await db.collection('users').doc(uid).get();
  const walletData = userSnap.data()?.wallet;
  if (!walletData?.encryptedKey) throw new Error('수탁 지갑이 없습니다');

  const provider = getProvider();

  // HEX 준비금 확인
  const coopMallRead = getCoopMallContract(provider);
  const hexBal       = await getHexTokenContract(provider).balanceOf(ADDRESSES.coopMall);
  if (hexBal < pts) throw new Error('컨트랙트 HEX 준비금 부족으로 전환 불가합니다');

  // BNB 가스비 보충
  const adminWallet = getAdminWallet();
  const bnbBal = await provider.getBalance(walletData.address);
  if (bnbBal < ethers.parseEther('0.00005')) {
    const fundTx = await adminWallet.sendTransaction({
      to: walletData.address, value: ethers.parseEther('0.0001'),
    });
    await fundTx.wait();
  }

  const privateKey   = decrypt(walletData.encryptedKey, masterSecret);
  const signer       = walletFromKey(privateKey, provider);
  const mallSigned   = getCoopMallContract(signer);
  const gasLimit     = await estimateGasWithBuffer(mallSigned, 'convertPoints', [pts]);
  const tx           = await mallSigned.convertPoints(pts, { gasLimit });
  const receipt      = await tx.wait();

  return {
    txHash:    receipt.hash,
    ptsHex:    parseFloat(ethers.formatEther(pts)).toFixed(4),
  };
}

module.exports = {
  listCoopProducts,
  buyCoopProduct,
  joinCoopMall,
  convertCoopPoints,
  adminSetCoopConfig,
  adminSaveCoopProduct,
  adminDeleteCoopProduct,
};
