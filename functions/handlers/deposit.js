// functions/handlers/deposit.js
// 원화(KRW) 입금 요청 → 관리자 확인 → 온체인 creditPoints 동기화
//
// 전체 흐름:
//  A) 유저: requestDeposit()   → Firestore에 pending 문서 생성 + 입금 안내 반환
//  B) 관리자: approveDeposit() → 환율 조회 → creditPoints() 온체인 호출 → approved
//  C) 조회: listPendingDeposits() → 관리자 대시보드용

'use strict';

const admin  = require('firebase-admin');
const { ethers } = require('ethers');
const {
  ADDRESSES,
  getAdminWallet,
  getProvider,
  getPlatformContract,
  getHexTokenContract,
  walletFromKey,
  estimateGasWithBuffer,
} = require('../wallet/chain');
const {
  fetchExchangeRates,
  krwToHexWei,
  krwToUsd,
  krwToVnd,
  toSnapshotScaled,
} = require('../wallet/exchange');
const { decrypt } = require('../wallet/crypto');
const { requireAdmin } = require('../wallet/admin');

const db = admin.firestore();

// 은행 계좌 정보
const BANK_INFO = {
  bank:    'IM뱅크',
  account: '253-08-000869-7',
  holder:  '신헌철',
};

const BANK_INFO_VND = {
  bank:    'TECHCOM BANK',
  account: '19037852768012',
  holder:  '신헌철 (SHIN HEON CHEOL)',
};

const MIN_KRW = 10_000;  // 최소 충전 금액

// ────────────────────────────────────────────────
// A. 유저: 입금 요청 생성
// ────────────────────────────────────────────────

/**
 * requestDeposit
 * - 고유 refCode 발급 → Firestore deposits/{refCode} 저장 → 입금 안내 반환
 * - refCode는 온체인 중복 방지(usedTopupRef)에도 사용됨
 *
 * @param {string} uid
 * @param {{ amountKrw: number, depositorName: string, bank?: string }} params
 * @returns {{ refCode, amountKrw, bankInfo, estimatedHex, estimatedVnd, estimatedUsd }}
 */
async function requestDeposit(uid, { amountKrw, depositorName, bank }) {
  // 입력 검증
  const amount = Math.floor(Number(amountKrw));
  if (!amount || amount < MIN_KRW) {
    throw new Error(`최소 충전 금액은 ${MIN_KRW.toLocaleString()}원입니다`);
  }
  if (!depositorName || depositorName.trim().length < 2) {
    throw new Error('입금자명(2자 이상)을 입력해주세요');
  }

  // 수탁 지갑 확인
  const userSnap = await db.collection('users').doc(uid).get();
  const address  = userSnap.data()?.wallet?.address;
  if (!address) {
    throw new Error('수탁 지갑이 없습니다. 먼저 회원가입을 완료해주세요');
  }

  // 현재 환율 조회 (표시용)
  let rates = null;
  try { rates = await fetchExchangeRates(); } catch (_) { /* 비필수 */ }

  // 고유 refCode (온체인 bytes32 해시 키로도 활용)
  const refCode   = `DEP-${uid.slice(0, 8).toUpperCase()}-${Date.now()}`;
  const refHash   = ethers.id(refCode); // keccak256 → bytes32

  await db.collection('deposits').doc(refCode).set({
    uid,
    userAddress:   address,
    amountKrw:     amount,
    depositorName: depositorName.trim(),
    bank:          bank || BANK_INFO.bank,
    refCode,
    refHash,       // 온체인과 동일 값 (감사 목적)
    status:        'pending',
    requestedAt:   admin.firestore.FieldValue.serverTimestamp(),
    rateAtRequest: rates
      ? { krwPerUsd: rates.krwPerUsd, vndPerUsd: rates.vndPerUsd, source: rates.source }
      : null,
  });

  // 응답 조립
  const estimatedHex = rates
    ? parseFloat(ethers.formatEther(krwToHexWei(amount, rates.krwPerUsd))).toFixed(4)
    : '환율 조회 실패';
  const estimatedUsd = rates ? krwToUsd(amount, rates.krwPerUsd) : null;
  const estimatedVnd = rates
    ? krwToVnd(amount, rates.krwPerUsd, rates.vndPerUsd).toLocaleString() + ' VND'
    : '환율 조회 실패';

  return {
    refCode,
    amountKrw:     amount,
    bankInfo:      BANK_INFO,
    bankInfoVnd:   BANK_INFO_VND,
    instruction:   `입금자명을 "${depositorName.trim()}"으로 정확히 입력하세요. 참조코드: ${refCode}`,
    estimatedHex,
    estimatedUsd,
    estimatedVnd,
  };
}

// ────────────────────────────────────────────────
// B. 관리자: 입금 승인 + 온체인 동기화
// ────────────────────────────────────────────────

/**
 * approveDeposit
 * 1. 관리자 권한 확인
 * 2. 실시간 환율 조회 → hexAmountWei 계산
 * 3. creditPoints() 호출 (관리자 지갑이 msg.sender=owner)
 *    → HEX transferFrom(owner → contract) + user.pointWei 증가
 * 4. Firestore 상태 업데이트
 *
 * 사전 조건: 관리자 지갑이 HEX.approve(jumpPlatform, 충분한 금액)을 미리 실행했어야 함
 *
 * @param {string} adminUid  - 관리자 Firebase UID
 * @param {string} refCode   - 승인할 입금 참조코드
 * @param {number|null} overrideKrwRate - 수동 환율 지정 (null이면 자동)
 * @returns {{ success, txHash, hexDisplay, usdAmount, vndAmount }}
 */
async function approveDeposit(adminUid, refCode, overrideKrwRate = null, masterSecret = null) {
  // ── 관리자 확인 (users.isAdmin / admins 컬렉션 / 이메일 허용목록 순) ──
  await requireAdmin(adminUid);

  // ── 입금 문서 조회 ──
  const depositRef  = db.collection('deposits').doc(refCode);
  const depositSnap = await depositRef.get();
  if (!depositSnap.exists) throw new Error('입금 요청을 찾을 수 없습니다');

  const dep = depositSnap.data();
  if (dep.status !== 'pending') {
    throw new Error(`이미 처리된 요청입니다 (상태: ${dep.status})`);
  }

  // ── 온체인 멤버 등록 확인 + 미등록 시 자동 등록 ──────────────────────
  const adminWallet  = getAdminWallet();
  const platformView = getPlatformContract(getProvider());
  const [memberLevel] = await platformView.members(dep.userAddress);
  const alreadyMember = Number(memberLevel) > 0;

  if (!alreadyMember) {
    // MetaMask 연결 지갑은 encryptedKey가 없으므로 서버에서 대신 등록 불가
    const userSnap   = await db.collection('users').doc(dep.uid).get();
    const walletData = userSnap.data()?.wallet;

    if (!walletData?.encryptedKey) {
      throw new Error(
        '온체인 미등록 상태입니다. 마이페이지 → "온체인 등록" 버튼을 먼저 눌러주세요.'
      );
    }
    if (!masterSecret) {
      throw new Error(
        '[서버 설정 오류] masterSecret 없음. approveDeposit Cloud Function에 WALLET_MASTER_SECRET Secret을 추가하세요.'
      );
    }

    // 1) 수탁 지갑에 가스비 BNB 소량 전송 (opBNB 가스비 충분)
    const fundTx = await adminWallet.sendTransaction({
      to:    dep.userAddress,
      value: ethers.parseEther('0.0001'),
    });
    await fundTx.wait();

    // 2) 수탁 지갑으로 register(ZeroAddress)
    const privateKey   = decrypt(walletData.encryptedKey, masterSecret);
    const userSigner   = walletFromKey(privateKey, getProvider());
    const userPlatform = getPlatformContract(userSigner);
    const regGasLimit  = await estimateGasWithBuffer(userPlatform, 'register', [ethers.ZeroAddress]);
    const regTx        = await userPlatform.register(ethers.ZeroAddress, { gasLimit: regGasLimit });
    await regTx.wait();

    // 3) Firestore 온체인 등록 상태 기록
    await db.collection('users').doc(dep.uid).set({
      onChain: {
        registered:     true,
        registeredAt:   admin.firestore.FieldValue.serverTimestamp(),
        mentorAddress:  ethers.ZeroAddress,
        txHash:         regTx.hash,
        autoRegistered: true,
      },
    }, { merge: true });
  }

  // ── 환율 조회 ──
  const rates = await fetchExchangeRates();
  const krwPerUsd = overrideKrwRate || rates.krwPerUsd;

  const hexAmountWei      = krwToHexWei(dep.amountKrw, krwPerUsd);
  const usdAmount         = krwToUsd(dep.amountKrw, krwPerUsd);
  const vndAmount         = krwToVnd(dep.amountKrw, krwPerUsd, rates.vndPerUsd);
  const usdKrwScaled      = toSnapshotScaled(krwPerUsd);
  const refBytes32        = ethers.id(refCode); // keccak256

  // ── 이중 승인 방지: 먼저 processing 상태로 변경 ──
  await depositRef.update({
    status:       'processing',
    processingAt: admin.firestore.FieldValue.serverTimestamp(),
    processingBy: adminUid,
  });

  try {
    // ── Step 1: HEX approve (필요 시 자동) → ownerDepositHex ──
    try {
      const hexContract = getHexTokenContract(adminWallet);

      // allowance 부족 시 MaxUint256 approve (관리자 지갑 → jumpPlatform)
      const allowance = await hexContract.allowance(adminWallet.address, ADDRESSES.butPlatform);
      if (allowance < hexAmountWei) {
        const approveTx = await hexContract.approve(ADDRESSES.butPlatform, ethers.MaxUint256);
        await approveTx.wait();
      }

      const platformDep = getPlatformContract(adminWallet);
      const depGasLimit = await estimateGasWithBuffer(platformDep, 'ownerDepositHex', [hexAmountWei]);
      const depTx       = await platformDep.ownerDepositHex(hexAmountWei, { gasLimit: depGasLimit });
      await depTx.wait();
    } catch (depositErr) {
      throw new Error(`관리자→컨트랙트 HEX 이체 실패 (ownerDepositHex): ${depositErr.message}`);
    }

    // ── 온체인 adminCreditHex 호출 ──
    let receipt;
    try {
      const platform = getPlatformContract(adminWallet);

      const gasLimit = await estimateGasWithBuffer(platform, 'adminCreditHex', [
        dep.userAddress,
        hexAmountWei,
        refBytes32,
      ]);

      const tx = await platform.adminCreditHex(
        dep.userAddress,
        hexAmountWei,
        refBytes32,
        { gasLimit }
      );
      receipt = await tx.wait();
    } catch (creditErr) {
      throw new Error(`포인트 지급 실패 (adminCreditHex): ${creditErr.message}`);
    }

    // ── Firestore 완료 처리 ──
    await depositRef.update({
      status:       'approved',
      approvedAt:   admin.firestore.FieldValue.serverTimestamp(),
      approvedBy:   adminUid,
      hexAmountWei: hexAmountWei.toString(),
      usdAmount,
      vndAmount,
      rateAtApproval: {
        krwPerUsd,
        vndPerUsd: rates.vndPerUsd,
        usdKrwScaled,
        source: rates.source,
      },
      txHash: receipt.hash,
    });

    // ── 유저 문서 미러 업데이트 (UI 빠른 표시용) ──
    await db.collection('users').doc(dep.uid).set({
      balanceMirror: {
        lastTopupAt:   admin.firestore.FieldValue.serverTimestamp(),
        lastTopupKrw:  dep.amountKrw,
        lastTopupHex:  hexAmountWei.toString(),
        lastTopupTx:   receipt.hash,
      },
    }, { merge: true });

    return {
      success:    true,
      txHash:     receipt.hash,
      hexDisplay: parseFloat(ethers.formatEther(hexAmountWei)).toFixed(4) + ' HEX',
      usdAmount,
      vndAmount,
      vndDisplay: vndAmount.toLocaleString() + ' VND',
    };

  } catch (err) {
    // 실패 시 pending 으로 롤백
    await depositRef.update({
      status:         'pending',
      processingAt:   admin.firestore.FieldValue.delete(),
      processingBy:   admin.firestore.FieldValue.delete(),
      lastError:      err.message,
      lastErrorAt:    admin.firestore.FieldValue.serverTimestamp(),
    });
    throw new Error(`온체인 creditPoints 실패: ${err.message}`);
  }
}

// ────────────────────────────────────────────────
// C. 관리자 대시보드: 대기중 입금 목록
// ────────────────────────────────────────────────

/**
 * listPendingDeposits
 * @param {string} adminUid
 * @returns {Array<Object>}
 */
async function listPendingDeposits(adminUid) {
  await requireAdmin(adminUid);

  // 인덱스 문제 해결: orderBy 제거하고 클라이언트 사이드에서 정렬
  const [pendingSnap, processingSnap] = await Promise.all([
    db.collection('deposits')
      .where('status', '==', 'pending')
      .limit(100)
      .get(),
    db.collection('deposits')
      .where('status', '==', 'processing')
      .limit(100)
      .get(),
  ]);

  const allDocs = [...pendingSnap.docs, ...processingSnap.docs];

  // 클라이언트 사이드에서 requestedAt 기준 최신순 정렬
  allDocs.sort((a, b) => {
    const aTime = a.data().requestedAt?.toDate?.()?.getTime?.() ?? 0;
    const bTime = b.data().requestedAt?.toDate?.()?.getTime?.() ?? 0;
    return bTime - aTime;
  });

  return allDocs.slice(0, 100).map((d) => {
    const data = d.data();
    return {
      refCode:       data.refCode,
      uid:           data.uid,
      userAddress:   data.userAddress,
      amountKrw:     data.amountKrw,
      depositorName: data.depositorName,
      bank:          data.bank,
      status:        data.status,
      requestedAt:   data.requestedAt?.toDate?.()?.toISOString?.() ?? null,
    };
  });
}

/**
 * getDepositHistory
 * 특정 유저의 충전 내역
 * @param {string} uid
 * @returns {Array<Object>}
 */
async function getDepositHistory(uid) {
  const snap = await db.collection('deposits')
    .where('uid', '==', uid)
    .orderBy('requestedAt', 'desc')
    .limit(50)
    .get();

  return snap.docs.map((d) => {
    const data = d.data();
    return {
      refCode:     data.refCode,
      amountKrw:   data.amountKrw,
      hexDisplay:  data.hexAmountWei
        ? parseFloat(ethers.formatEther(data.hexAmountWei)).toFixed(4) + ' HEX'
        : '-',
      usdAmount:   data.usdAmount ?? null,
      vndAmount:   data.vndAmount ?? null,
      status:      data.status,
      txHash:      data.txHash ?? null,
      requestedAt: data.requestedAt?.toDate?.()?.toISOString?.() ?? null,
      approvedAt:  data.approvedAt?.toDate?.()?.toISOString?.() ?? null,
    };
  });
}

module.exports = {
  requestDeposit,
  approveDeposit,
  listPendingDeposits,
  getDepositHistory,
};
