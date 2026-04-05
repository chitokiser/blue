// functions/handlers/transaction.js
// 수탁 지갑 서명 트랜잭션: 구매(buy) / 인출(withdraw) / 관리자 HEX 사전 approve

'use strict';

const admin  = require('firebase-admin');
const { ethers } = require('ethers');
const { decrypt } = require('../wallet/crypto');
const {
  getProvider,
  getPlatformContract,
  getHexContract,
  walletFromKey,
  getAdminWallet,
  estimateGasWithBuffer,
  ADDRESSES,
} = require('../wallet/chain');
const { requireAdmin } = require('../wallet/admin');

const db = admin.firestore();

// ────────────────────────────────────────────────
// 구매 (buy)
// ────────────────────────────────────────────────

/**
 * buyProduct
 * 유저의 수탁 지갑이 msg.sender로 jumpPlatform.buy(productId) 서명 + 전송
 * - pointWei 자동 차감 (컨트랙트 내부 처리)
 * - 판매자/멘토 payableWei 자동 적립 (컨트랙트 내부 처리)
 *
 * @param {string} uid          - Firebase Auth UID
 * @param {number} productId    - 상품 ID
 * @param {string} masterSecret - WALLET_MASTER_SECRET
 * @returns {{ txHash, productId }}
 */
async function buyProduct(uid, productId, masterSecret) {
  // 수탁 지갑 조회
  const userSnap   = await db.collection('users').doc(uid).get();
  const walletData = userSnap.data()?.wallet;
  if (!walletData?.encryptedKey) {
    throw new Error('수탁 지갑이 없습니다');
  }

  // private key 복호화
  const privateKey = decrypt(walletData.encryptedKey, masterSecret);
  const provider   = getProvider();
  const signer     = walletFromKey(privateKey, provider);
  const platform   = getPlatformContract(signer);

  // 온체인 상품 정보 확인
  const [exists, , priceWei, , isActive] = await platform.getProduct(productId);
  if (!exists)    throw new Error(`상품 ID ${productId}가 존재하지 않습니다`);
  if (!isActive)  throw new Error(`상품 ID ${productId}가 비활성 상태입니다`);

  // 포인트 잔액 확인
  const [, , pointWei] = await platform.getMember(walletData.address);
  if (pointWei < priceWei) {
    throw new Error(
      `포인트 부족. 보유: ${ethers.formatEther(pointWei)} HEX, 필요: ${ethers.formatEther(priceWei)} HEX`
    );
  }

  // 가스 추정 + 여유
  const gasLimit = await estimateGasWithBuffer(platform, 'buy', [productId]);
  const tx       = await platform.buy(productId, { gasLimit });
  const receipt  = await tx.wait();

  // 거래 로그 기록
  await db.collection('transactions').add({
    uid,
    userAddress: walletData.address,
    type:        'buy',
    productId,
    priceWei:    priceWei.toString(),
    txHash:      receipt.hash,
    createdAt:   admin.firestore.FieldValue.serverTimestamp(),
  });

  return { txHash: receipt.hash, productId };
}

// ────────────────────────────────────────────────
// 인출 (withdraw) – payableWei → HEX를 자신의 지갑으로
// ────────────────────────────────────────────────

/**
 * withdrawPayable
 * 수탁 지갑 또는 개인 지갑으로 payableWei 인출
 *
 * ⚠️  수탁 지갑 인출: 서버가 대신 서명 (편리하지만 서버 리스크)
 *     개인 지갑 인출: 개인 지갑에서 직접 withdraw() 호출 권장
 *
 * @param {string} uid          - Firebase Auth UID
 * @param {string} amountWeiStr - 인출할 금액 (wei 단위 문자열, "all"이면 전액)
 * @param {string} masterSecret - WALLET_MASTER_SECRET
 * @returns {{ txHash, amountDisplay }}
 */
async function withdrawPayable(uid, amountWeiStr, masterSecret) {
  const userSnap   = await db.collection('users').doc(uid).get();
  const walletData = userSnap.data()?.wallet;
  if (!walletData?.encryptedKey) throw new Error('수탁 지갑이 없습니다');

  const privateKey = decrypt(walletData.encryptedKey, masterSecret);
  const provider   = getProvider();
  const signer     = walletFromKey(privateKey, provider);
  const platform   = getPlatformContract(signer);

  // payableWei 조회
  const [, , , payableWei] = await platform.getMember(walletData.address);

  let amountWei;
  if (amountWeiStr === 'all') {
    amountWei = payableWei;
  } else {
    amountWei = BigInt(amountWeiStr);
  }

  if (amountWei <= 0n) throw new Error('인출 금액이 0입니다');
  if (amountWei > payableWei) {
    throw new Error(
      `인출 가능 금액 초과. 가능: ${ethers.formatEther(payableWei)} HEX`
    );
  }

  const gasLimit = await estimateGasWithBuffer(platform, 'withdraw', [amountWei]);
  const tx       = await platform.withdraw(amountWei, { gasLimit });
  const receipt  = await tx.wait();

  await db.collection('transactions').add({
    uid,
    userAddress: walletData.address,
    type:        'withdraw',
    amountWei:   amountWei.toString(),
    txHash:      receipt.hash,
    createdAt:   admin.firestore.FieldValue.serverTimestamp(),
  });

  return {
    txHash:        receipt.hash,
    amountDisplay: parseFloat(ethers.formatEther(amountWei)).toFixed(4) + ' HEX',
  };
}

// ────────────────────────────────────────────────
// 관리자: HEX.approve() 사전 실행 (1회)
// ────────────────────────────────────────────────

/**
 * adminApproveHex
 * 관리자 지갑 → jumpPlatform 컨트랙트에 HEX 지출 권한 부여
 * creditPoints() 호출 전에 반드시 1회 실행 필요
 * 권장: uint256 최대값으로 approve (무한 승인)
 *
 * @param {string} adminUid
 * @param {string|null} amountWeiStr null이면 MaxUint256
 * @returns {{ txHash, allowanceDisplay }}
 */
async function adminApproveHex(adminUid, amountWeiStr = null) {
  await requireAdmin(adminUid);

  const adminWallet = getAdminWallet();
  const hexContract = getHexContract(adminWallet);

  const amount = amountWeiStr ? BigInt(amountWeiStr) : ethers.MaxUint256;
  const tx     = await hexContract.approve(ADDRESSES.butPlatform, amount);
  const receipt= await tx.wait();

  const allowanceDisplay = amount === ethers.MaxUint256
    ? '무한 (MaxUint256)'
    : parseFloat(ethers.formatEther(amount)).toFixed(4) + ' HEX';

  return { txHash: receipt.hash, allowanceDisplay };
}

/**
 * adminCheckAllowance
 * 관리자 HEX allowance 현재값 조회
 * @returns {{ allowanceWei, allowanceDisplay }}
 */
async function adminCheckAllowance() {
  const adminWallet = getAdminWallet();
  const hexContract = getHexContract(getProvider());

  const allowance = await hexContract.allowance(
    adminWallet.address,
    ADDRESSES.jumpPlatform
  );

  return {
    allowanceWei:     allowance.toString(),
    allowanceDisplay: parseFloat(ethers.formatEther(allowance)).toFixed(4) + ' HEX',
    isMaxUint:        allowance === ethers.MaxUint256,
  };
}

/**
 * adminGetContractStatus
 * jumpPlatform 컨트랙트 + 관리자 지갑 현황 종합 조회
 * - contractHexBalance : 컨트랙트가 보유한 HEX (사용자 pointWei + payableWei 합산)
 * - ownerHexAllowance  : 관리자→컨트랙트 HEX 지출 한도
 * - adminHexBalance    : 관리자 지갑 HEX 잔액 (충전 재원)
 * - adminBnbBalance    : 관리자 지갑 BNB 잔액 (가스비)
 */
async function adminGetContractStatus() {
  const provider    = getProvider();
  const adminWallet = getAdminWallet();
  const hexContract = getHexContract(provider);
  const platform    = getPlatformContract(provider);
  const { fetchExchangeRates } = require('../wallet/exchange');

  const [
    contractHexBal,
    ownerAllowance,
    adminHexBal,
    adminBnbBal,
    rates,
  ] = await Promise.all([
    hexContract.balanceOf(ADDRESSES.butPlatform),
    hexContract.allowance(adminWallet.address, ADDRESSES.butPlatform),
    hexContract.balanceOf(adminWallet.address),
    provider.getBalance(adminWallet.address),
    fetchExchangeRates().catch(() => null),
  ]);

  const krwPerUsd = rates?.krwPerUsd ?? null;
  const hexToKrw = (wei) => {
    if (!krwPerUsd) return null;
    return Math.round(parseFloat(ethers.formatEther(wei)) * krwPerUsd);
  };

  return {
    adminAddress:     adminWallet.address,
    contractAddress:  ADDRESSES.butPlatform,

    // 컨트랙트 HEX 잔액
    contractHexWei:          contractHexBal.toString(),
    contractHexDisplay:      parseFloat(ethers.formatEther(contractHexBal)).toFixed(4) + ' HEX',
    contractHexKrw:          hexToKrw(contractHexBal),

    // 관리자 HEX 잔액
    adminHexWei:             adminHexBal.toString(),
    adminHexDisplay:         parseFloat(ethers.formatEther(adminHexBal)).toFixed(4) + ' HEX',
    adminHexKrw:             hexToKrw(adminHexBal),

    // 관리자 BNB 잔액 (가스비)
    adminBnbDisplay:         parseFloat(ethers.formatEther(adminBnbBal)).toFixed(6) + ' BNB',

    // HEX Allowance
    ownerHexAllowanceWei:     ownerAllowance.toString(),
    ownerHexAllowanceDisplay: ownerAllowance === ethers.MaxUint256
      ? '∞ MaxUint256'
      : parseFloat(ethers.formatEther(ownerAllowance)).toFixed(4) + ' HEX',
    isMaxUint:                ownerAllowance === ethers.MaxUint256,

    // 환율
    krwPerUsd,
    rateSource: rates?.source ?? 'N/A',
  };
}

/**
 * adminRecordP2pTransfer
 * 외부 지갑 → 수탁 지갑으로 직접 전송된 HEX를 거래 내역에 기록
 * 1. txHash로 온체인 Transfer 이벤트 파싱
 * 2. 수신 지갑 주소 → Firestore에서 uid 조회
 * 3. transactions 컬렉션에 type:'p2p'로 저장
 *
 * @param {string} adminUid
 * @param {string} txHash   - HEX Transfer 트랜잭션 해시
 * @returns {{ uid, from, to, amountHex, amountKrw, txHash }}
 */
async function adminRecordP2pTransfer(adminUid, txHash) {
  await requireAdmin(adminUid);

  const provider = getProvider();

  // 트랜잭션 영수증 조회
  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt) throw new Error('트랜잭션을 찾을 수 없습니다: ' + txHash);

  // Transfer 이벤트 파싱
  const hexAddr    = ADDRESSES.jumpToken.toLowerCase();
  const transferIface = new ethers.Interface([
    'event Transfer(address indexed from, address indexed to, uint256 value)',
  ]);
  const transferTopic = transferIface.getEvent('Transfer').topicHash;

  const transferLog = receipt.logs.find(
    (log) => log.address.toLowerCase() === hexAddr && log.topics[0] === transferTopic
  );
  if (!transferLog) throw new Error('이 트랜잭션에서 HEX Transfer 이벤트를 찾을 수 없습니다');

  const parsed = transferIface.parseLog(transferLog);
  const from   = parsed.args.from;
  const to     = parsed.args.to;
  const value  = parsed.args.value;

  // 수신 주소 → uid 조회
  const usersSnap = await db.collection('users')
    .where('wallet.address', '==', to)
    .limit(1)
    .get();
  if (usersSnap.empty) throw new Error('수탁 지갑 소유자를 찾을 수 없습니다: ' + to);
  const uid = usersSnap.docs[0].id;

  // 중복 기록 방지
  const dupSnap = await db.collection('transactions')
    .where('txHash', '==', txHash)
    .limit(1)
    .get();
  if (!dupSnap.empty) throw new Error('이미 기록된 트랜잭션입니다');

  // 환율 조회 (표시용)
  const { fetchExchangeRates } = require('../wallet/exchange');
  const rates     = await fetchExchangeRates().catch(() => null);
  const krwPerUsd = rates?.krwPerUsd ?? null;
  const hexAmount = parseFloat(ethers.formatEther(value));
  const amountKrw = krwPerUsd ? Math.round(hexAmount * krwPerUsd) : null;
  const amountUsd = Math.round(hexAmount * 100) / 100;
  const amountVnd = (rates?.vndPerUsd && krwPerUsd)
    ? Math.round(hexAmount * rates.vndPerUsd)
    : null;

  await db.collection('transactions').add({
    uid,
    userAddress:  to,
    fromAddress:  from,
    type:         'p2p',
    amountWei:    value.toString(),
    amountHex:    hexAmount.toFixed(4),
    amountKrw,
    amountUsd,
    amountVnd,
    txHash,
    recordedBy:   adminUid,
    createdAt:    admin.firestore.FieldValue.serverTimestamp(),
  });

  return { success: true, uid, from, to, amountHex: hexAmount.toFixed(4), amountKrw, txHash };
}

/**
 * mergeWalletHexToPoints
 * 수탁 지갑의 실제 HEX 잔액(P2P 수령분)을 컨트랙트 pointWei로 합산
 *
 * 흐름:
 *   1) 수탁 지갑 → 관리자 지갑으로 HEX 전송  (walletHex → adminWallet)
 *   2) 관리자 지갑 → jumpPlatform.creditPoints()  (adminWallet → contract)
 *   3) user.pointWei 증가 (컨트랙트 내부)
 *
 * @param {string} uid          - Firebase Auth UID
 * @param {string} masterSecret - WALLET_MASTER_SECRET
 * @returns {{ txHash, amountHex, amountKrw }}
 */
async function mergeWalletHexToPoints(uid, masterSecret) {
  const userSnap   = await db.collection('users').doc(uid).get();
  const walletData = userSnap.data()?.wallet;
  if (!walletData?.encryptedKey) throw new Error('수탁 지갑이 없습니다');

  const provider    = getProvider();
  const adminWallet = getAdminWallet();
  const hexContract = getHexContract(provider);

  // 수탁 지갑 HEX 잔액 확인
  const walletHexBal = await hexContract.balanceOf(walletData.address);
  if (walletHexBal === 0n) throw new Error('합산할 HEX 잔액이 없습니다');

  // BNB 가스비 부족 시 보충
  const bnbBal = await provider.getBalance(walletData.address);
  if (bnbBal < ethers.parseEther('0.00005')) {
    const fundTx = await adminWallet.sendTransaction({
      to: walletData.address, value: ethers.parseEther('0.0001'),
    });
    await fundTx.wait();
  }

  // 1) 수탁 지갑 → 관리자 지갑으로 HEX 이동
  const privateKey   = decrypt(walletData.encryptedKey, masterSecret);
  const userSigner   = walletFromKey(privateKey, provider);
  const hexWithUser  = getHexContract(userSigner);
  const transferTx   = await hexWithUser.transfer(adminWallet.address, walletHexBal);
  await transferTx.wait();

  // 환율 조회
  const { fetchExchangeRates } = require('../wallet/exchange');
  const rates        = await fetchExchangeRates().catch(() => null);
  const krwPerUsd    = rates?.krwPerUsd ?? 1370;
  const hexAmount    = parseFloat(ethers.formatEther(walletHexBal));
  const amountKrw    = Math.round(hexAmount * krwPerUsd);

  // 2) adminCreditHex (관리자 지갑 → 컨트랙트, user.points 증가)
  const refStr    = `P2P-MERGE-${uid.slice(0, 8).toUpperCase()}-${Date.now()}`;
  const refBytes  = ethers.id(refStr);
  const platform  = getPlatformContract(adminWallet);
  const gasLimit  = await estimateGasWithBuffer(platform, 'adminCreditHex', [
    walletData.address, walletHexBal, refBytes,
  ]);
  const creditTx  = await platform.adminCreditHex(
    walletData.address, walletHexBal, refBytes, { gasLimit }
  );
  const receipt = await creditTx.wait();

  // 3) Firestore 기록
  await db.collection('transactions').add({
    uid,
    userAddress: walletData.address,
    type:        'p2p_merge',
    amountWei:   walletHexBal.toString(),
    amountHex:   hexAmount.toFixed(4),
    amountKrw,
    txHash:      receipt.hash,
    refCode:     refStr,
    createdAt:   admin.firestore.FieldValue.serverTimestamp(),
  });

  return { success: true, txHash: receipt.hash, amountHex: hexAmount.toFixed(4), amountKrw };
}

// ────────────────────────────────────────────────
// 레벨업 요청 (수탁 지갑 서명)
// ────────────────────────────────────────────────

/**
 * requestLevelUp
 * 유저의 수탁 지갑으로 jumpPlatform.requestLevelUp() 서명 + 전송
 * 조건: exp >= level² × 10000
 *
 * @param {string} uid          - Firebase Auth UID
 * @param {string} masterSecret - WALLET_MASTER_SECRET
 * @returns {{ txHash, newLevel }}
 */
async function requestLevelUp(uid, masterSecret) {
  const userSnap   = await db.collection('users').doc(uid).get();
  const walletData = userSnap.data()?.wallet;
  if (!walletData?.encryptedKey) throw new Error('수탁 지갑이 없습니다');

  const privateKey = decrypt(walletData.encryptedKey, masterSecret);
  const provider   = getProvider();
  const signer     = walletFromKey(privateKey, provider);
  const platform   = getPlatformContract(signer);

  // 현재 레벨 확인 (members 매핑: level, mentor, exp, points, blocked)
  const [level, , exp] = await platform.members(walletData.address);
  const requiredExp = BigInt(level) * BigInt(level) * 10000n;
  if (exp < requiredExp) {
    throw new Error(
      `EXP 부족. 필요: ${requiredExp.toString()}, 현재: ${exp.toString()}`
    );
  }

  const gasLimit = await estimateGasWithBuffer(platform, 'requestLevelUp', []);
  const tx       = await platform.requestLevelUp({ gasLimit });
  const receipt  = await tx.wait();

  return { txHash: receipt.hash, newLevel: Number(level) + 1 };
}

// ────────────────────────────────────────────────
// 가맹점(판매회원) 온체인 등록
// ────────────────────────────────────────────────

/**
 * registerMerchantOnChain
 * 유저의 수탁 지갑으로 jumpPlatform.registerMerchant(metadataURI) 서명 + 전송
 * - onlyMember: 온체인 회원(level > 0) 이어야 함
 * - 초기 feeBps = 0 → 관리자가 이후 adminUpdateMerchantFee(id, 1000) 으로 10% 설정
 *
 * @param {string} uid           - Firebase Auth UID
 * @param {string} metadataURI   - 온체인 메타데이터 URI (compact JSON 등)
 * @param {object} merchantData  - Firestore에 저장할 판매자 정보
 * @param {string} masterSecret  - WALLET_MASTER_SECRET
 * @returns {{ txHash, merchantId }}
 */
async function registerMerchantOnChain(uid, metadataURI, merchantData, masterSecret) {
  const userSnap   = await db.collection('users').doc(uid).get();
  const walletData = userSnap.data()?.wallet;
  if (!walletData?.encryptedKey) throw new Error('수탁 지갑이 없습니다. 먼저 지갑을 생성해 주세요.');

  // onlyMember 조건 사전 확인
  const provider = getProvider();
  const platform  = getPlatformContract(provider);
  const [level, , , , blocked] = await platform.members(walletData.address);
  if (Number(level) === 0) throw new Error('온체인 회원 등록이 필요합니다. 마이페이지에서 먼저 온체인 등록을 완료해 주세요.');
  if (blocked) throw new Error('차단된 계정입니다. 관리자에게 문의하세요.');

  // 수탁 지갑으로 registerMerchant 호출
  const privateKey     = decrypt(walletData.encryptedKey, masterSecret);
  const signer         = walletFromKey(privateKey, provider);
  const platformSigner = getPlatformContract(signer);

  const gasLimit = await estimateGasWithBuffer(platformSigner, 'registerMerchant', [metadataURI]);
  const tx       = await platformSigner.registerMerchant(metadataURI, { gasLimit });
  const receipt  = await tx.wait();

  // MerchantRegistered 이벤트에서 merchantId 파싱
  const iface = platformSigner.interface;
  let merchantId = null;
  for (const log of receipt.logs) {
    try {
      const parsed = iface.parseLog(log);
      if (parsed?.name === 'MerchantRegistered') {
        merchantId = Number(parsed.args.merchantId);
        break;
      }
    } catch { /* 다른 이벤트 로그 무시 */ }
  }
  if (merchantId === null) throw new Error('merchantId 파싱 실패: MerchantRegistered 이벤트를 찾을 수 없습니다');

  // Firestore 저장 (merchants/{merchantId})
  await db.collection('merchants').doc(String(merchantId)).set({
    merchantId,
    ownerUid:     uid,
    ownerAddress: walletData.address,
    ...merchantData,
    feeBps:       0,   // 관리자가 이후 1000 (10%) 으로 설정
    active:       true,
    txHash:       receipt.hash,
    createdAt:    admin.firestore.FieldValue.serverTimestamp(),
  });

  // 유저 문서에 merchantId 기록
  await db.collection('users').doc(uid).set({
    merchantId,
    merchantRegisteredAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  return { txHash: receipt.hash, merchantId };
}

// ────────────────────────────────────────────────
// 관리자: 가맹점 수수료 설정 (onchain adminUpdateMerchantFee)
// ────────────────────────────────────────────────

/**
 * adminSetMerchantFeeOnChain
 * 관리자 지갑으로 jumpPlatform.adminUpdateMerchantFee(merchantId, feeBps) 호출
 * feeBps=1000 → 10%, feeBps=0 → 0%
 *
 * @param {number} merchantId
 * @param {number} feeBps  - 0~10000 (basis points)
 * @returns {{ txHash, merchantId, feeBps }}
 */
async function adminSetMerchantFeeOnChain(merchantId, feeBps) {
  const adminWallet = getAdminWallet();
  const platform    = getPlatformContract(adminWallet);

  const gasLimit = await estimateGasWithBuffer(platform, 'adminUpdateMerchantFee', [merchantId, feeBps]);
  const tx       = await platform.adminUpdateMerchantFee(merchantId, feeBps, { gasLimit });
  const receipt  = await tx.wait();

  // Firestore 동기화
  await db.collection('merchants').doc(String(merchantId)).update({
    feeBps,
    approvedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return { txHash: receipt.hash, merchantId, feeBps };
}

// ────────────────────────────────────────────────
// 가맹점 오프라인 결제 (수탁 지갑 → payMerchantHex)
// ────────────────────────────────────────────────

/**
 * payMerchantHexOnChain
 * 유저 수탁 지갑의 HEX로 jumpPlatform.payMerchantHex() 호출
 * 흐름: KRW → HEX wei 환산 → approve → payMerchantHex
 *
 * @param {string} uid          - Firebase Auth UID
 * @param {number} merchantId   - 가맹점 ID (온체인)
 * @param {number} amountKrw    - 결제 원화 금액
 * @param {string} masterSecret - WALLET_MASTER_SECRET
 * @returns {{ txHash, amountHex, amountKrw, merchantName }}
 */
async function payMerchantHexOnChain(uid, merchantId, amountKrw, masterSecret, { currency = 'KRW', amountVnd } = {}) {
  // 수탁 지갑 조회
  const userSnap   = await db.collection('users').doc(uid).get();
  const walletData = userSnap.data()?.wallet;
  if (!walletData?.encryptedKey) throw new Error('수탁 지갑이 없습니다. 먼저 지갑을 생성해 주세요.');

  // 가맹점 확인 (Firestore)
  const merchantSnap = await db.collection('merchants').doc(String(merchantId)).get();
  if (!merchantSnap.exists) throw new Error(`가맹점 ID ${merchantId}를 찾을 수 없습니다`);
  const merchant = merchantSnap.data() || {};
  if (merchant.active === false) throw new Error('비활성 가맹점입니다');

  // 환율 조회 + 금액 → HEX wei 변환
  const { fetchExchangeRates, krwToHexWei } = require('../wallet/exchange');
  const rates = await fetchExchangeRates();

  let hexWei;
  if (currency === 'VND' && amountVnd) {
    const vndScaled  = BigInt(Math.round(amountVnd * 10000));
    const rateScaled = BigInt(Math.round(rates.vndPerUsd * 10000));
    hexWei = (vndScaled * (10n ** 18n)) / rateScaled;
    // amountKrw 역산 (기록용)
    amountKrw = Math.round((amountVnd / rates.vndPerUsd) * rates.krwPerUsd);
  } else {
    hexWei = krwToHexWei(amountKrw, rates.krwPerUsd);
  }
  if (hexWei <= 0n) throw new Error('결제 금액이 너무 작습니다');

  // 수탁 지갑 HEX ERC20 잔액 확인
  const provider   = getProvider();
  const hexRead    = getHexContract(provider);
  const walletBal  = await hexRead.balanceOf(walletData.address);
  if (walletBal < hexWei) {
    const have = parseFloat(ethers.formatEther(walletBal)).toFixed(4);
    const need = parseFloat(ethers.formatEther(hexWei)).toFixed(4);
    throw new Error(`HEX 잔액 부족. 보유: ${have} HEX, 필요: ${need} HEX`);
  }

  // BNB 가스비 부족 시 소액 보충
  const bnbBal = await provider.getBalance(walletData.address);
  if (bnbBal < ethers.parseEther('0.0001')) {
    const adminWallet = getAdminWallet();
    const fundTx = await adminWallet.sendTransaction({
      to: walletData.address, value: ethers.parseEther('0.0002'),
    });
    await fundTx.wait();
  }

  // private key 복호화 + 서명자 생성
  const privateKey = decrypt(walletData.encryptedKey, masterSecret);
  const signer     = walletFromKey(privateKey, provider);
  const hexSigned  = getHexContract(signer);
  const platform   = getPlatformContract(signer);

  // 1) HEX approve
  const approveTx = await hexSigned.approve(ADDRESSES.jumpPlatform, hexWei);
  await approveTx.wait();

  // 2) payMerchantHex
  const gasLimit = await estimateGasWithBuffer(platform, 'payMerchantHex', [merchantId, hexWei]);
  const tx       = await platform.payMerchantHex(merchantId, hexWei, { gasLimit });
  const receipt  = await tx.wait();

  // 거래 기록 — 구매자 측
  const hexAmount = parseFloat(ethers.formatEther(hexWei));
  await db.collection('transactions').add({
    uid,
    userAddress:  walletData.address,
    type:         'pay_merchant',
    merchantId:   Number(merchantId),
    merchantName: merchant.name || '',
    amountWei:    hexWei.toString(),
    amountHex:    hexAmount.toFixed(4),
    amountKrw,
    ...(currency === 'VND' && amountVnd ? { amountVnd, currency: 'VND' } : { currency: 'KRW' }),
    txHash:       receipt.hash,
    createdAt:    admin.firestore.FieldValue.serverTimestamp(),
  });

  // 거래 기록 — 가맹점 수입
  // ownerUid 없으면 ownerAddress로 users 컬렉션 fallback 조회
  let merchantOwnerUid = merchant.ownerUid || null;
  if (!merchantOwnerUid && merchant.ownerAddress) {
    const ownerQuery = await db.collection('users')
      .where('wallet.address', '==', merchant.ownerAddress)
      .limit(1)
      .get();
    if (!ownerQuery.empty) {
      merchantOwnerUid = ownerQuery.docs[0].id;
      // Firestore 문서에 ownerUid 보완 저장 (이후 재조회 불필요)
      await db.collection('merchants').doc(String(merchantId)).update({ ownerUid: merchantOwnerUid });
    }
  }

  if (merchantOwnerUid) {
    const feeBig = BigInt(merchant.feeBps ?? 0);
    const feeWei = (hexWei * feeBig) / 10000n;
    const netWei = hexWei - feeWei;
    await db.collection('transactions').add({
      uid:          merchantOwnerUid,
      type:         'merchant_income',
      merchantId:   Number(merchantId),
      merchantName: merchant.name || '',
      buyerUid:     uid,
      amountWei:    hexWei.toString(),
      netAmountWei: netWei.toString(),
      feeWei:       feeWei.toString(),
      feeBps:       merchant.feeBps ?? 0,
      amountKrw,
      ...(currency === 'VND' && amountVnd ? { amountVnd, currency: 'VND' } : { currency: 'KRW' }),
      txHash:       receipt.hash,
      createdAt:    admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  // 빨간약 지급: 1 HEX당 1/10 확률로 1병
  let potionCount = 0;
  for (let i = 0; i < Math.floor(hexAmount); i++) {
    if (Math.random() < 0.1) potionCount++;
  }
  if (potionCount > 0) {
    const invRef = db.collection('treasure_inventory').doc(`${uid}_potion_red`);
    await db.runTransaction(async (tx) => {
      const snap    = await tx.get(invRef);
      const current = snap.exists ? (snap.data().count || 0) : 0;
      tx.set(invRef, {
        uid, itemId: 'potion_red', count: current + potionCount,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    });
  }

  // 마법약 지급: 1 HEX당 15% 확률
  let mpPotionCount = 0;
  for (let i = 0; i < Math.floor(hexAmount); i++) {
    if (Math.random() < 0.15) mpPotionCount++;
  }
  if (mpPotionCount > 0) {
    const mpRef = db.collection('treasure_inventory').doc(`${uid}_potion_mp`);
    await db.runTransaction(async (tx) => {
      const snap    = await tx.get(mpRef);
      const current = snap.exists ? (snap.data().count || 0) : 0;
      tx.set(mpRef, {
        uid, itemId: 'potion_mp', count: current + mpPotionCount,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    });
  }

  // 부활 아이템 지급: 1 HEX당 20% 확률 (5분의 1)
  let reviveAdded = 0;
  for (let i = 0; i < Math.floor(hexAmount); i++) {
    if (Math.random() < 0.2) reviveAdded++;
  }
  if (reviveAdded > 0) {
    const revRef = db.collection('treasure_inventory').doc(`${uid}_revive_ticket`);
    await db.runTransaction(async (tx) => {
      const snap    = await tx.get(revRef);
      const current = snap.exists ? (snap.data().count || 0) : 0;
      tx.set(revRef, {
        uid, itemId: 'revive_ticket', count: current + reviveAdded,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    });
  }

  // 잭팟: 전체 결제에서 1% 확률 — 빨간약 5병 + 마법약 3병 + 부활 2개 보너스
  let isJackpot = false;
  if (Math.random() < 0.01) {
    isJackpot = true;
    const jpPotion = db.collection('treasure_inventory').doc(`${uid}_potion_red`);
    const jpMp     = db.collection('treasure_inventory').doc(`${uid}_potion_mp`);
    const jpRevive = db.collection('treasure_inventory').doc(`${uid}_revive_ticket`);
    await db.runTransaction(async (tx) => {
      const [ps, ms, rs] = await Promise.all([tx.get(jpPotion), tx.get(jpMp), tx.get(jpRevive)]);
      tx.set(jpPotion, { uid, itemId:'potion_red',     count: (ps.exists?ps.data().count||0:0)+5,  updatedAt:admin.firestore.FieldValue.serverTimestamp() }, { merge:true });
      tx.set(jpMp,     { uid, itemId:'potion_mp',      count: (ms.exists?ms.data().count||0:0)+3,  updatedAt:admin.firestore.FieldValue.serverTimestamp() }, { merge:true });
      tx.set(jpRevive, { uid, itemId:'revive_ticket',  count: (rs.exists?rs.data().count||0:0)+2,  updatedAt:admin.firestore.FieldValue.serverTimestamp() }, { merge:true });
    });
    potionCount   += 5;
    mpPotionCount += 3;
    reviveAdded   += 2;
  }

  return {
    txHash:       receipt.hash,
    amountHex:    hexAmount.toFixed(4),
    amountKrw,
    ...(currency === 'VND' && amountVnd ? { amountVnd, currency: 'VND' } : { currency: 'KRW' }),
    merchantName:  merchant.name || '',
    potionsAdded:  potionCount,
    mpPotionsAdded: mpPotionCount,
    reviveAdded,
    isJackpot,
  };
}

// ────────────────────────────────────────────────
// 관리자: 컨트랙트에 HEX 충전 (ownerDepositHex)
// ────────────────────────────────────────────────

/**
 * adminOwnerDepositHex
 * 관리자 지갑 HEX → jumpPlatform 컨트랙트로 충전
 * 사전 조건: HEX.approve(platform, amount) 완료 상태 (무한 approve 권장)
 *
 * @param {string} amountWeiStr - 충전할 HEX (wei 단위 문자열)
 * @returns {{ txHash, amountDisplay }}
 */
async function adminOwnerDepositHex(amountWeiStr) {
  const adminWallet = getAdminWallet();
  const provider    = getProvider();
  const hexContract = getHexContract(provider);
  const platform    = getPlatformContract(adminWallet);

  const amount = BigInt(amountWeiStr);
  if (amount <= 0n) throw new Error('충전 금액이 0입니다');

  // ── 사전 진단: 잔액 / allowance 확인 ──
  const [hexBal, allowance] = await Promise.all([
    hexContract.balanceOf(adminWallet.address),
    hexContract.allowance(adminWallet.address, ADDRESSES.jumpPlatform),
  ]);

  if (hexBal < amount) {
    throw new Error(
      `관리자 서버지갑(${adminWallet.address}) HEX 잔액 부족.\n` +
      `보유: ${ethers.formatEther(hexBal)} HEX, 필요: ${ethers.formatEther(amount)} HEX.\n` +
      `이 주소로 HEX를 송금하거나 ADMIN_PRIVATE_KEY를 HEX 보유 지갑으로 변경하세요.`
    );
  }
  if (allowance < amount) {
    throw new Error(
      `관리자 서버지갑(${adminWallet.address})의 jumpPlatform Approve가 부족합니다.\n` +
      `현재 allowance: ${ethers.formatEther(allowance)} HEX.\n` +
      `관리자 페이지 → "무한 Approve" 버튼을 다시 실행하세요.`
    );
  }

  const gasLimit = await estimateGasWithBuffer(platform, 'ownerDepositHex', [amount]);
  const tx       = await platform.ownerDepositHex(amount, { gasLimit });
  const receipt  = await tx.wait();

  return {
    txHash:        receipt.hash,
    amountDisplay: parseFloat(ethers.formatEther(amount)).toFixed(4) + ' HEX',
    adminAddress:  adminWallet.address,
  };
}

// ────────────────────────────────────────────────
// 상품 HEX 즉시결제 (수탁 지갑 → 판매자)
// ────────────────────────────────────────────────

/**
 * payProductWithHex
 * Firestore 상품(items/{itemId})을 유저의 수탁 지갑 HEX로 즉시 구매
 * 흐름: 가격 조회 → HEX 환산 → BNB 가스 보충 → approve → payMerchantHex (또는 직접 전송) → 주문 생성
 *
 * @param {string} uid
 * @param {object} params - { itemId, date, startDate, endDate, people, phone, memo, bookingMode }
 * @param {string} masterSecret
 * @returns {{ orderId, txHash, hexAmountDisplay, totalPrice, currency }}
 */
async function payProductWithHex(uid, params, masterSecret) {
  const { itemId, date, startDate, endDate, people, phone, memo, bookingMode } = params || {};

  // 1. 유저 지갑 조회
  const userSnap   = await db.collection('users').doc(uid).get();
  const userData   = userSnap.data() || {};
  const walletData = userData.wallet;
  if (!walletData?.encryptedKey) throw new Error('수탁 지갑이 없습니다. 먼저 지갑을 생성하세요.');

  // 2. 상품 조회
  const itemSnap = await db.collection('items').doc(itemId).get();
  if (!itemSnap.exists) throw new Error('상품이 존재하지 않습니다.');
  const item     = itemSnap.data();
  if (!['published', 'approved'].includes(item.status)) throw new Error('구매 불가능한 상품입니다.');

  const ownerUid = item.ownerUid || item.guideUid || '';
  if (ownerUid === uid) throw new Error('본인 상품은 구매할 수 없습니다.');

  // 3. 금액 계산
  const unitPrice  = Number(item.price || item.amount || 0);
  const currency   = String(item.currency || 'KRW').toUpperCase();
  const bMode      = String(bookingMode || item.booking?.mode || 'date_single');

  let nights = 0;
  if (bMode === 'date_range' && startDate && endDate) {
    nights = Math.floor((new Date(endDate) - new Date(startDate)) / 86400000);
    if (nights < 0) nights = 0;
  }
  const totalPrice = bMode === 'date_range' ? unitPrice * nights : unitPrice;
  if (totalPrice <= 0) throw new Error('결제 금액이 0입니다. 날짜와 금액을 확인하세요.');

  // 4. 환율 조회 + HEX wei 변환 (1 HEX = 1 USD)
  const { fetchExchangeRates, krwToHexWei } = require('../wallet/exchange');
  const rates = await fetchExchangeRates();

  let hexWei;
  if (currency === 'VND') {
    const vndScaled  = BigInt(Math.round(totalPrice * 10000));
    const rateScaled = BigInt(Math.round(rates.vndPerUsd * 10000));
    hexWei = (vndScaled * (10n ** 18n)) / rateScaled;
  } else if (currency === 'USD') {
    hexWei = BigInt(Math.round(totalPrice * 1e6)) * (10n ** 12n);
  } else {
    hexWei = krwToHexWei(totalPrice, rates.krwPerUsd); // KRW (default)
  }
  if (hexWei <= 0n) throw new Error('환산된 HEX 금액이 0입니다.');

  // 5. 지갑 HEX 잔액 확인
  const provider  = getProvider();
  const hexRead   = getHexContract(provider);
  const walletBal = await hexRead.balanceOf(walletData.address);
  if (walletBal < hexWei) {
    const have = parseFloat(ethers.formatEther(walletBal)).toFixed(4);
    const need = parseFloat(ethers.formatEther(hexWei)).toFixed(4);
    throw new Error(`HEX 잔액 부족. 보유: ${have} HEX, 필요: ${need} HEX (약 ${totalPrice.toLocaleString()} ${currency})`);
  }

  // 6. BNB 가스비 보충 (필요 시)
  const bnbBal = await provider.getBalance(walletData.address);
  if (bnbBal < ethers.parseEther('0.0001')) {
    const adminWallet = getAdminWallet();
    const fundTx = await adminWallet.sendTransaction({
      to: walletData.address, value: ethers.parseEther('0.0002'),
    });
    await fundTx.wait();
  }

  // 7. 판매자 정보 조회
  const sellerSnap      = await db.collection('users').doc(ownerUid).get();
  const sellerData      = sellerSnap.data() || {};
  const sellerMerchantId = sellerData.merchantId != null ? Number(sellerData.merchantId) : null;
  const sellerAddress   = sellerData.wallet?.address;

  // 8. 수탁 지갑 서명자 생성
  const privateKey = decrypt(walletData.encryptedKey, masterSecret);
  const signer     = walletFromKey(privateKey, provider);
  const hexSigned  = getHexContract(signer);
  const platform   = getPlatformContract(signer);

  let txHash;
  if (sellerMerchantId !== null) {
    // 판매자가 가맹점 등록: payMerchantHex (수수료·멘토 분배 포함)
    const approveTx = await hexSigned.approve(ADDRESSES.jumpPlatform, hexWei);
    await approveTx.wait();
    const gasLimit = await estimateGasWithBuffer(platform, 'payMerchantHex', [sellerMerchantId, hexWei]);
    const tx       = await platform.payMerchantHex(sellerMerchantId, hexWei, { gasLimit });
    const receipt  = await tx.wait();
    txHash = receipt.hash;
  } else if (sellerAddress) {
    // 판매자 가맹점 미등록: 직접 HEX 전송
    const gasLimit = await estimateGasWithBuffer(hexSigned, 'transfer', [sellerAddress, hexWei]);
    const tx       = await hexSigned.transfer(sellerAddress, hexWei, { gasLimit });
    const receipt  = await tx.wait();
    txHash = receipt.hash;
  } else {
    throw new Error('판매자의 지갑 정보가 없습니다. 판매자가 지갑을 먼저 생성해야 합니다.');
  }

  // 9. 주문 생성 (confirmed)
  const now             = new Date();
  const settlementMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const firstImg        = (() => {
    const imgs = item.images || [];
    const f    = imgs[0];
    if (!f) return '';
    return typeof f === 'string' ? f : (f.url || f.src || '');
  })();

  const orderRef = await db.collection('orders').add({
    itemId,
    itemTitle:        item.title || '',
    itemThumb:        firstImg,

    ownerUid,
    guideUid:         ownerUid,

    buyerUid:         uid,
    buyerEmail:       userData.email || '',
    buyerPhone:       String(phone || '').trim(),

    bookingMode:      bMode,
    date:             String(date || '').trim(),
    startDate:        String(startDate || '').trim(),
    endDate:          String(endDate || '').trim(),
    nights,
    people:           Number(people) || 1,
    memo:             String(memo || '').trim(),

    unitPrice,
    amount:           totalPrice,
    price:            totalPrice,
    currency,

    hexAmountWei:     hexWei.toString(),
    hexAmountDisplay: parseFloat(ethers.formatEther(hexWei)).toFixed(4) + ' HEX',
    rateAtPayment: {
      krwPerUsd: rates.krwPerUsd,
      vndPerUsd: rates.vndPerUsd,
      source:    rates.source,
    },

    payment:          'points',
    payMethod:        'points',
    status:           'confirmed',
    paymentStatus:    'confirmed',
    settlementMonth,

    txHash,
    paidAt:           admin.firestore.FieldValue.serverTimestamp(),
    createdAt:        admin.firestore.FieldValue.serverTimestamp(),
    updatedAt:        admin.firestore.FieldValue.serverTimestamp(),
  });

  // 10. 거래 로그
  await db.collection('transactions').add({
    uid,
    userAddress: walletData.address,
    type:        'pay_product',
    itemId,
    orderId:     orderRef.id,
    merchantId:  sellerMerchantId,
    amountWei:   hexWei.toString(),
    amountHex:   parseFloat(ethers.formatEther(hexWei)).toFixed(4),
    amountKrw:   currency === 'KRW' ? totalPrice : null,
    amountVnd:   currency === 'VND' ? totalPrice : null,
    txHash,
    createdAt:   admin.firestore.FieldValue.serverTimestamp(),
  });

  return {
    orderId:          orderRef.id,
    txHash,
    hexAmountDisplay: parseFloat(ethers.formatEther(hexWei)).toFixed(4) + ' HEX',
    totalPrice,
    currency,
    rateSource:       rates.source,
  };
}

// ────────────────────────────────────────────────
// 관리자: 멘티 멘토 일괄 변경 (adminChangeMentor)
// ────────────────────────────────────────────────

/**
 * adminBulkChangeMentor
 * 온체인 등록된 유저들의 mentor를 일괄 변경
 * - Firestore users 컬렉션에서 onChain.registered=true 유저 목록 조회
 * - 각 유저 주소에 대해 platform.adminChangeMentor(userAddr, newMentor) 호출
 * - Firestore onChain.mentorAddress 동기화
 *
 * @param {string} newMentorAddress - 새 멘토 지갑 주소
 * @param {string[]} [targetUids]   - 특정 uid 목록 (없으면 전체 등록 유저)
 * @returns {{ success, updated, skipped, failed }}
 */
async function adminBulkChangeMentor(newMentorAddress, targetUids = null) {
  if (!ethers.isAddress(newMentorAddress)) throw new Error('유효하지 않은 멘토 주소입니다');

  const adminWallet = getAdminWallet();
  const platform    = getPlatformContract(adminWallet);

  // 대상 유저 조회
  let usersSnap;
  if (targetUids && targetUids.length > 0) {
    const docs = await Promise.all(
      targetUids.map(uid => db.collection('users').doc(uid).get())
    );
    usersSnap = { docs };
  } else {
    usersSnap = await db.collection('users')
      .where('onChain.registered', '==', true)
      .get();
  }

  const results = { updated: [], skipped: [], failed: [] };

  for (const doc of usersSnap.docs) {
    const uid     = doc.id;
    const data    = doc.data() || {};
    const address = data.wallet?.address;

    if (!address) { results.skipped.push({ uid, reason: '지갑 없음' }); continue; }
    if (!data.onChain?.registered) { results.skipped.push({ uid, reason: '온체인 미등록' }); continue; }
    if (address.toLowerCase() === newMentorAddress.toLowerCase()) {
      results.skipped.push({ uid, reason: '본인은 자기 멘토 불가' }); continue;
    }

    try {
      // 현재 온체인 mentor 확인
      const [, currentMentor] = await platform.members(address);
      if (currentMentor.toLowerCase() === newMentorAddress.toLowerCase()) {
        results.skipped.push({ uid, reason: '이미 해당 멘토' }); continue;
      }

      const gasLimit = await estimateGasWithBuffer(platform, 'adminChangeMentor', [address, newMentorAddress]);
      const tx       = await platform.adminChangeMentor(address, newMentorAddress, { gasLimit });
      await tx.wait();

      // Firestore 동기화
      await db.collection('users').doc(uid).update({
        'onChain.mentorAddress': newMentorAddress,
      });

      results.updated.push({ uid, address });
    } catch (err) {
      results.failed.push({ uid, address, error: err.message });
    }
  }

  return {
    success:  results.failed.length === 0,
    updated:  results.updated.length,
    skipped:  results.skipped.length,
    failed:   results.failed.length,
    details:  results,
  };
}

// ────────────────────────────────────────────────
// 관리자: 특정 유저 레벨 설정 (adminSetLevel)
// ────────────────────────────────────────────────

/**
 * adminSetUserLevel
 * 이메일 또는 uid로 유저를 찾아 온체인 레벨 설정
 *
 * @param {string} emailOrUid - 유저 이메일 또는 Firebase UID
 * @param {number} level      - 설정할 레벨 (1~10)
 * @returns {{ uid, address, level, txHash }}
 */
async function adminSetUserLevel(emailOrUid, level) {
  if (!Number.isInteger(level) || level < 1 || level > 10) {
    throw new Error('레벨은 1~10 사이 정수여야 합니다');
  }

  // uid 또는 이메일로 유저 조회
  let uid, address;
  const db = admin.firestore();

  // 이메일처럼 보이면 이메일로 조회
  if (emailOrUid.includes('@')) {
    const snap = await db.collection('users')
      .where('email', '==', emailOrUid.toLowerCase().trim())
      .limit(1).get();
    if (snap.empty) throw new Error(`유저를 찾을 수 없습니다: ${emailOrUid}`);
    uid     = snap.docs[0].id;
    address = snap.docs[0].data()?.wallet?.address;
  } else {
    uid = emailOrUid;
    const snap = await db.collection('users').doc(uid).get();
    if (!snap.exists) throw new Error(`유저를 찾을 수 없습니다: ${uid}`);
    address = snap.data()?.wallet?.address;
  }

  if (!address) throw new Error('해당 유저에게 지갑이 없습니다');

  const adminWallet = getAdminWallet();
  const platform    = getPlatformContract(adminWallet);

  const gasLimit = await estimateGasWithBuffer(platform, 'adminSetLevel', [address, level]);
  const tx       = await platform.adminSetLevel(address, level, { gasLimit });
  const receipt  = await tx.wait();

  return { uid, address, level, txHash: receipt.hash };
}

// ────────────────────────────────────────────────
// 레벨4+ HEX → 개인 지갑 이체
// ────────────────────────────────────────────────

/**
 * transferHexToPersonal
 * 레벨 4 이상 유저: 수탁 지갑의 HEX를 외부(개인) 지갑으로 직접 전송
 *
 * @param {string} uid          - Firebase Auth UID
 * @param {string} toAddress    - 수령 지갑 주소 (0x...)
 * @param {string} amountWeiStr - 이체 금액 wei 문자열 또는 "all"
 * @param {string} masterSecret - WALLET_MASTER_SECRET
 * @returns {{ txHash, amountHex, toAddress }}
 */
async function transferHexToPersonal(uid, toAddress, amountWeiStr, masterSecret) {
  if (!ethers.isAddress(toAddress)) throw new Error('유효하지 않은 지갑 주소입니다');

  const userSnap   = await db.collection('users').doc(uid).get();
  const walletData = userSnap.data()?.wallet;
  if (!walletData?.encryptedKey) throw new Error('수탁 지갑이 없습니다');

  // 온체인 레벨 확인 (레벨 4 이상만 허용)
  const provider  = getProvider();
  const platform  = getPlatformContract(provider);
  const [levelVal] = await platform.members(walletData.address);
  const level = Number(levelVal);
  if (level < 4) {
    throw new Error(`레벨 4 이상만 개인 지갑 이체가 가능합니다. (현재 레벨: ${level})`);
  }

  // HEX 잔액 확인
  const hexRead = getHexContract(provider);
  const hexBal  = await hexRead.balanceOf(walletData.address);

  const amount = amountWeiStr === 'all' ? hexBal : BigInt(amountWeiStr);
  if (amount <= 0n) throw new Error('이체 금액이 0입니다');
  if (hexBal < amount) {
    throw new Error(
      `HEX 잔액 부족. 보유: ${parseFloat(ethers.formatEther(hexBal)).toFixed(4)} HEX, ` +
      `요청: ${parseFloat(ethers.formatEther(amount)).toFixed(4)} HEX`
    );
  }

  // BNB 가스비 부족 시 소액 보충
  const adminWallet = getAdminWallet();
  const bnbBal = await provider.getBalance(walletData.address);
  if (bnbBal < ethers.parseEther('0.00005')) {
    const fundTx = await adminWallet.sendTransaction({
      to: walletData.address, value: ethers.parseEther('0.0001'),
    });
    await fundTx.wait();
  }

  // HEX 전송
  const privateKey  = decrypt(walletData.encryptedKey, masterSecret);
  const signer      = walletFromKey(privateKey, provider);
  const hexSigned   = getHexContract(signer);
  const gasLimit    = await estimateGasWithBuffer(hexSigned, 'transfer', [toAddress, amount]);
  const tx          = await hexSigned.transfer(toAddress, amount, { gasLimit });
  const receipt     = await tx.wait();

  const amountHex = parseFloat(ethers.formatEther(amount)).toFixed(4);

  await db.collection('transactions').add({
    uid,
    userAddress: walletData.address,
    type:        'hex_transfer',
    toAddress,
    amountWei:   amount.toString(),
    amountHex,
    txHash:      receipt.hash,
    createdAt:   admin.firestore.FieldValue.serverTimestamp(),
  });

  return { txHash: receipt.hash, amountHex, toAddress };
}

/**
 * redeemPoints
 * 멘토 포인트(pointWei) → HEX로 전환 (mentorWithdrawPoints 호출)
 * 최소 전환: 100,000 VND 상당 (≈ 4 HEX)
 *
 * @param {string} uid          - Firebase Auth UID
 * @param {string} masterSecret - WALLET_MASTER_SECRET
 * @returns {{ txHash, amountHex, amountVnd }}
 */
async function redeemPoints(uid, masterSecret) {
  const userSnap   = await db.collection('users').doc(uid).get();
  const walletData = userSnap.data()?.wallet;
  if (!walletData?.encryptedKey) throw new Error('수탁 지갑이 없습니다');

  const provider = getProvider();
  const platform = getPlatformContract(provider);

  // 포인트 잔액 조회
  const [, , , points] = await platform.members(walletData.address);
  if (points === 0n) throw new Error('전환할 포인트가 없습니다');

  // 최소 전환 금액 체크 (100,000 VND 상당 ≈ 4 HEX)
  const MIN_HEX_WEI = ethers.parseEther('4');
  if (points < MIN_HEX_WEI) {
    throw new Error(
      `최소 전환 금액은 4 HEX(≈ 100,000 VND)입니다. 현재: ${parseFloat(ethers.formatEther(points)).toFixed(4)} HEX`
    );
  }

  // BNB 가스비 부족 시 보충
  const adminWallet = getAdminWallet();
  const bnbBal = await provider.getBalance(walletData.address);
  if (bnbBal < ethers.parseEther('0.00005')) {
    const fundTx = await adminWallet.sendTransaction({
      to: walletData.address, value: ethers.parseEther('0.0001'),
    });
    await fundTx.wait();
  }

  // 수탁 지갑 서명으로 mentorWithdrawPoints 호출
  const privateKey    = decrypt(walletData.encryptedKey, masterSecret);
  const userSigner    = walletFromKey(privateKey, provider);
  const platformUser  = getPlatformContract(userSigner);
  const gasLimit      = await estimateGasWithBuffer(platformUser, 'mentorWithdrawPoints', [points]);
  const tx            = await platformUser.mentorWithdrawPoints(points, { gasLimit });
  const receipt       = await tx.wait();

  const amountHex = parseFloat(ethers.formatEther(points)).toFixed(4);

  // Firestore 기록
  await db.collection('transactions').add({
    uid,
    userAddress: walletData.address,
    type:        'redeem_points',
    amountWei:   points.toString(),
    amountHex,
    txHash:      receipt.hash,
    createdAt:   admin.firestore.FieldValue.serverTimestamp(),
  });

  return { success: true, txHash: receipt.hash, amountHex };
}

module.exports = {
  buyProduct,
  withdrawPayable,
  requestLevelUp,
  registerMerchantOnChain,
  adminSetMerchantFeeOnChain,
  adminApproveHex,
  adminCheckAllowance,
  adminGetContractStatus,
  adminRecordP2pTransfer,
  mergeWalletHexToPoints,
  payMerchantHexOnChain,
  adminOwnerDepositHex,
  payProductWithHex,
  adminBulkChangeMentor,
  adminSetUserLevel,
  transferHexToPersonal,
  redeemPoints,
};
