// functions/index.js
// Firebase Cloud Functions 진입점 – 수탁형 지갑 + 기존 리뷰 집계
//
// ──────────────────────────────────────────────────────
// [최초 1회 Secret 등록]
//   firebase functions:secrets:set WALLET_MASTER_SECRET
//   firebase functions:secrets:set ADMIN_PRIVATE_KEY
//
// [배포]
//   firebase deploy --only functions
//
// [로컬 에뮬레이터]
//   WALLET_MASTER_SECRET=xxx ADMIN_PRIVATE_KEY=0x... firebase emulators:start
// ──────────────────────────────────────────────────────

'use strict';

const admin = require('firebase-admin');
const { onDocumentWritten }  = require('firebase-functions/v2/firestore');
const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule }         = require('firebase-functions/v2/scheduler');
const { defineSecret }       = require('firebase-functions/params');
const { logger }             = require('firebase-functions');

admin.initializeApp();
const db = admin.firestore();

// ── Firebase Secret Manager ──────────────────────────────────────────────────
const walletSecret  = defineSecret('WALLET_MASTER_SECRET');
const adminKeySecret= defineSecret('ADMIN_PRIVATE_KEY');
const extApiSecret  = defineSecret('PARTNER_API_KEY');

// ── 핸들러 ───────────────────────────────────────────────────────────────────
const onboarding             = require('./handlers/onboarding');
const depositH               = require('./handlers/deposit');
const txH                    = require('./handlers/transaction');
const exchangeH              = require('./handlers/exchange');
const butTokenH              = require('./handlers/butToken');
const coopH                  = require('./handlers/coop');
const daoH                   = require('./handlers/dao');
const zaloH                  = require('./handlers/zalopay');
const treasureH              = require('./handlers/treasure');
const communityH             = require('./handlers/community');
const buggyH                 = require('./handlers/buggy');
const { requireAdmin }       = require('./wallet/admin');

// ────────────────────────────────────────────────────────────────────────────
// 유틸 함수
// ────────────────────────────────────────────────────────────────────────────
function requireAuth(request) {
  if (!request.auth?.uid) {
    throw new HttpsError('unauthenticated', '로그인이 필요합니다');
  }
  return request.auth.uid;
}

/** 에러를 HttpsError로 래핑하고 로그 기록 */
function wrapError(fn) {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      logger.error('[Functions Error]', err);
      if (err instanceof HttpsError) throw err;
      throw new HttpsError('internal', err.message || '서버 오류');
    }
  };
}

// ════════════════════════════════════════════════════════════════════════════
// 1. 수탁 지갑 생성
//    클라이언트: httpsCallable(functions, 'createWallet')()
// ════════════════════════════════════════════════════════════════════════════
exports.createWallet = onCall(
  { secrets: [walletSecret, adminKeySecret] },
  wrapError(async (request) => {
    const uid           = requireAuth(request);
    const mentorAddress = request.data?.mentorAddress ?? null;
    process.env.ADMIN_PRIVATE_KEY = adminKeySecret.value();
    const result = await onboarding.createCustodialWallet(uid, walletSecret.value(), mentorAddress);
    logger.info('createWallet', { uid, address: result.address, created: result.created, registered: result.registered });
    return result;
  })
);

// ════════════════════════════════════════════════════════════════════════════
// 1-b. 관리자 셀프 온보딩 (ADMIN_PRIVATE_KEY 지갑 → 플랫폼 연결)
//      클라이언트: httpsCallable(functions, 'adminSelfOnboard')()
// ════════════════════════════════════════════════════════════════════════════
exports.adminSelfOnboard = onCall(
  { secrets: [adminKeySecret] },
  wrapError(async (request) => {
    const uid = requireAuth(request);
    await requireAdmin(uid);
    process.env.ADMIN_PRIVATE_KEY = adminKeySecret.value();
    const result = await onboarding.adminSelfOnboard(uid);
    logger.info('adminSelfOnboard', { uid, address: result.address, level: result.level });
    return result;
  })
);

// ════════════════════════════════════════════════════════════════════════════
// 2. 온체인 회원 가입
//    클라이언트: httpsCallable(functions, 'registerMember')({ mentorAddress: '0x...' })
//    mentorAddress 필수 — 없으면 에러
// ════════════════════════════════════════════════════════════════════════════
exports.registerMember = onCall(
  { secrets: [walletSecret] },
  wrapError(async (request) => {
    const uid           = requireAuth(request);
    const mentorAddress = request.data?.mentorAddress ?? null;
    const result = await onboarding.registerOnChain(uid, mentorAddress, walletSecret.value());
    logger.info('registerMember', { uid, mentorAddress, txHash: result.txHash });
    return result;
  })
);

// ════════════════════════════════════════════════════════════════════════════
// 3. 멘토 등록 (이메일 ↔ 지갑 주소 연결)
//    cors: true → 127.0.0.1:5500 포함 모든 오리진 허용
//    클라이언트: fetch(url, { method:'POST', headers:{ Authorization:'Bearer {idToken}' }, body: JSON.stringify({address,signature}) })
//
//    프론트 서명 메시지:
//      const msg = `Jump Platform 멘토 등록\nEmail: ${email.toLowerCase()}`;
//      personal_sign(hexEncode(msg), address)
// ════════════════════════════════════════════════════════════════════════════
exports.linkMentor = onRequest(
  { cors: true },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method Not Allowed' });
      return;
    }
    try {
      // Firebase Auth 토큰 검증
      const authHeader = req.headers.authorization || '';
      if (!authHeader.startsWith('Bearer ')) {
        res.status(401).json({ error: '로그인이 필요합니다' });
        return;
      }
      let decoded;
      try {
        decoded = await admin.auth().verifyIdToken(authHeader.slice(7));
      } catch (_) {
        res.status(401).json({ error: '인증 토큰이 유효하지 않습니다' });
        return;
      }

      const email = decoded.email;
      if (!email) {
        res.status(401).json({ error: '구글 이메일 인증이 필요합니다' });
        return;
      }

      const { address, signature } = req.body ?? {};
      if (!address || !signature) {
        res.status(400).json({ error: 'address와 signature가 필요합니다' });
        return;
      }

      const result = await onboarding.registerMentor(email, address, signature);
      logger.info('linkMentor', { uid: decoded.uid, email, address });
      res.json(result);
    } catch (err) {
      logger.error('[linkMentor Error]', err);
      res.status(500).json({ error: err.message || '서버 오류' });
    }
  }
);

// ════════════════════════════════════════════════════════════════════════════
// 4. 내 온체인 정보 조회 (포인트, payable, 레벨 등)
//    클라이언트: httpsCallable(functions, 'getMyOnChain')()
// ════════════════════════════════════════════════════════════════════════════
exports.getMyOnChain = onCall(
  wrapError(async (request) => {
    const uid = requireAuth(request);
    return await onboarding.getUserOnChainData(uid);
  })
);

// ════════════════════════════════════════════════════════════════════════════
// 5. 원화 입금 요청 (유저)
//    클라이언트: httpsCallable(functions, 'requestDeposit')({ amountKrw: 100000, depositorName: '홍길동' })
// ════════════════════════════════════════════════════════════════════════════
exports.requestDeposit = onCall(
  wrapError(async (request) => {
    const uid = requireAuth(request);
    const { amountKrw, depositorName, bank } = request.data ?? {};
    if (!amountKrw) throw new HttpsError('invalid-argument', 'amountKrw가 필요합니다');
    if (!depositorName) throw new HttpsError('invalid-argument', 'depositorName이 필요합니다');
    const result = await depositH.requestDeposit(uid, { amountKrw, depositorName, bank });
    logger.info('requestDeposit', { uid, amountKrw, refCode: result.refCode });
    return result;
  })
);

// ════════════════════════════════════════════════════════════════════════════
// 6. 충전 내역 조회 (유저)
//    클라이언트: httpsCallable(functions, 'getDepositHistory')()
// ════════════════════════════════════════════════════════════════════════════
exports.getDepositHistory = onCall(
  wrapError(async (request) => {
    const uid = requireAuth(request);
    return await depositH.getDepositHistory(uid);
  })
);

// ════════════════════════════════════════════════════════════════════════════
// 7. 관리자: 입금 승인 + 온체인 creditPoints
//    클라이언트: httpsCallable(functions, 'approveDeposit')({ refCode: 'DEP-XXX', overrideKrwRate: null })
//    overrideKrwRate: 수동 환율 지정 (null이면 자동 조회)
// ════════════════════════════════════════════════════════════════════════════
exports.approveDeposit = onCall(
  { secrets: [adminKeySecret, walletSecret] },
  wrapError(async (request) => {
    const adminUid = requireAuth(request);
    const { refCode, overrideKrwRate } = request.data ?? {};
    if (!refCode) throw new HttpsError('invalid-argument', 'refCode가 필요합니다');

    // Secret을 process.env에 주입 (chain.js의 getAdminWallet()이 읽음)
    process.env.ADMIN_PRIVATE_KEY = adminKeySecret.value();

    const result = await depositH.approveDeposit(adminUid, refCode, overrideKrwRate ?? null, walletSecret.value());
    logger.info('approveDeposit', { adminUid, refCode, txHash: result.txHash });
    return result;
  })
);

// ════════════════════════════════════════════════════════════════════════════
// 8. 관리자: 대기중 입금 목록
//    클라이언트: httpsCallable(functions, 'listPendingDeposits')()
// ════════════════════════════════════════════════════════════════════════════
exports.listPendingDeposits = onCall(
  wrapError(async (request) => {
    const adminUid = requireAuth(request);
    return await depositH.listPendingDeposits(adminUid);
  })
);

// ════════════════════════════════════════════════════════════════════════════
// 9. 레벨업 요청 (수탁 지갑 서명)
//    클라이언트: httpsCallable(functions, 'requestLevelUp')()
// ════════════════════════════════════════════════════════════════════════════
exports.requestLevelUp = onCall(
  { secrets: [walletSecret] },
  wrapError(async (request) => {
    const uid = requireAuth(request);
    const result = await txH.requestLevelUp(uid, walletSecret.value());
    logger.info('requestLevelUp', { uid, newLevel: result.newLevel, txHash: result.txHash });
    return result;
  })
);

// ════════════════════════════════════════════════════════════════════════════
// 11. 상품 구매 (수탁 지갑 서명)
//    클라이언트: httpsCallable(functions, 'buyProduct')({ productId: 1 })
// ════════════════════════════════════════════════════════════════════════════
exports.buyProduct = onCall(
  { secrets: [walletSecret] },
  wrapError(async (request) => {
    const uid       = requireAuth(request);
    const productId = request.data?.productId;
    if (!productId) throw new HttpsError('invalid-argument', 'productId가 필요합니다');
    const result = await txH.buyProduct(uid, Number(productId), walletSecret.value());
    logger.info('buyProduct', { uid, productId, txHash: result.txHash });
    return result;
  })
);

// ════════════════════════════════════════════════════════════════════════════
// 10. 인출 – payableWei → HEX 전송 (수탁 지갑 서명)
//     클라이언트: httpsCallable(functions, 'withdraw')({ amountWei: '1000000000000000000' })
//     { amountWei: 'all' } 이면 전액 인출
// ════════════════════════════════════════════════════════════════════════════
exports.withdraw = onCall(
  { secrets: [walletSecret] },
  wrapError(async (request) => {
    const uid       = requireAuth(request);
    const amountWei = request.data?.amountWei ?? 'all';
    const result = await txH.withdrawPayable(uid, amountWei, walletSecret.value());
    logger.info('withdraw', { uid, amountWei, txHash: result.txHash });
    return result;
  })
);

// ════════════════════════════════════════════════════════════════════════════
// 11. 관리자: HEX approve 실행 (최초 1회 필수)
//     jumpPlatform이 owner 지갑에서 HEX를 끌어올 수 있도록
//     클라이언트: httpsCallable(functions, 'adminApproveHex')({ amountWei: null })
//     amountWei: null → MaxUint256 (무한 승인)
// ════════════════════════════════════════════════════════════════════════════
exports.adminApproveHex = onCall(
  { secrets: [adminKeySecret] },
  wrapError(async (request) => {
    const adminUid = requireAuth(request);
    process.env.ADMIN_PRIVATE_KEY = adminKeySecret.value();
    const result = await txH.adminApproveHex(adminUid, request.data?.amountWei ?? null);
    logger.info('adminApproveHex', { adminUid, ...result });
    return result;
  })
);

// ════════════════════════════════════════════════════════════════════════════
// 12. 관리자: HEX allowance 조회
//     클라이언트: httpsCallable(functions, 'adminCheckAllowance')()
// ════════════════════════════════════════════════════════════════════════════
exports.adminCheckAllowance = onCall(
  { secrets: [adminKeySecret] },
  wrapError(async (request) => {
    requireAuth(request);
    process.env.ADMIN_PRIVATE_KEY = adminKeySecret.value();
    return await txH.adminCheckAllowance();
  })
);

// ════════════════════════════════════════════════════════════════════════════
// 13. 관리자: 컨트랙트 + 관리자 지갑 현황 조회
//     클라이언트: httpsCallable(functions, 'adminGetContractStatus')()
// ════════════════════════════════════════════════════════════════════════════
exports.adminGetContractStatus = onCall(
  { secrets: [adminKeySecret] },
  wrapError(async (request) => {
    requireAuth(request);
    process.env.ADMIN_PRIVATE_KEY = adminKeySecret.value();
    return await txH.adminGetContractStatus();
  })
);

// ════════════════════════════════════════════════════════════════════════════
// 14. 관리자: P2P HEX 전송 기록 (txHash로 수동 등록)
//     클라이언트: httpsCallable(functions, 'adminRecordP2pTransfer')({ txHash: '0x...' })
// ════════════════════════════════════════════════════════════════════════════
exports.adminRecordP2pTransfer = onCall(
  wrapError(async (request) => {
    const adminUid = requireAuth(request);
    const { txHash } = request.data ?? {};
    if (!txHash) throw new HttpsError('invalid-argument', 'txHash가 필요합니다');
    const result = await txH.adminRecordP2pTransfer(adminUid, txHash);
    logger.info('adminRecordP2pTransfer', { adminUid, txHash, uid: result.uid });
    return result;
  })
);

// ════════════════════════════════════════════════════════════════════════════
// 15. 유저: P2P 수령 HEX → pointWei 합산 (수탁 지갑 전용)
//     수탁 지갑 HEX → 관리자 지갑 → creditPoints → pointWei 증가
//     클라이언트: httpsCallable(functions, 'mergeWalletHexToPoints')()
// ════════════════════════════════════════════════════════════════════════════
exports.mergeWalletHexToPoints = onCall(
  { secrets: [walletSecret, adminKeySecret] },
  wrapError(async (request) => {
    const uid = requireAuth(request);
    process.env.ADMIN_PRIVATE_KEY = adminKeySecret.value();
    const result = await txH.mergeWalletHexToPoints(uid, walletSecret.value());
    logger.info('mergeWalletHexToPoints', { uid, txHash: result.txHash, amountHex: result.amountHex });
    return result;
  })
);

// ════════════════════════════════════════════════════════════════════════════
// 16-A. 유저: 멘토 포인트 → HEX 전환 (최소 100,000 VND 상당 ≈ 4 HEX)
//       클라이언트: httpsCallable(functions, 'redeemPoints')()
// ════════════════════════════════════════════════════════════════════════════
exports.redeemPoints = onCall(
  { secrets: [walletSecret, adminKeySecret] },
  wrapError(async (request) => {
    const uid = requireAuth(request);
    process.env.ADMIN_PRIVATE_KEY = adminKeySecret.value();
    const result = await txH.redeemPoints(uid, walletSecret.value());
    logger.info('redeemPoints', { uid, txHash: result.txHash, amountHex: result.amountHex });
    return result;
  })
);

// ════════════════════════════════════════════════════════════════════════════
// 16. 판매회원 온체인 등록
//     - 수탁 지갑으로 jumpPlatform.registerMerchant(metadataURI) 호출 (onlyMember)
//     - 초기 feeBps=0 → 관리자가 adminUpdateMerchantFee(id, 1000) 으로 10% 설정
//     클라이언트: httpsCallable(functions, 'registerMerchant')({ name, description, phone, kakaoId, region, career })
// ════════════════════════════════════════════════════════════════════════════
exports.registerMerchant = onCall(
  { secrets: [walletSecret] },
  wrapError(async (request) => {
    const uid = requireAuth(request);
    const { name, description, phone, kakaoId, region, career, gmap } = request.data ?? {};
    if (!name) throw new HttpsError('invalid-argument', '가게명(name)이 필요합니다');

    // 온체인 metadataURI: compact JSON (가스 절약)
    const metadataURI = JSON.stringify({
      n: name,
      r: region  || '',
      c: career  || '',
      d: (description || '').slice(0, 120),
    });

    const merchantData = { name, description: description || '', phone: phone || '', kakaoId: kakaoId || '', region: region || '', career: career || '', ...(gmap ? { gmap } : {}) };
    const result = await txH.registerMerchantOnChain(uid, metadataURI, merchantData, walletSecret.value());
    logger.info('registerMerchant', { uid, merchantId: result.merchantId, txHash: result.txHash });
    return result;
  })
);

// ════════════════════════════════════════════════════════════════════════════
// 17. 관리자: 가맹점 수수료 설정 (승인)
//     - 관리자 지갑으로 jumpPlatform.adminUpdateMerchantFee(id, feeBps) 호출
//     클라이언트: httpsCallable(functions, 'adminSetMerchantFee')({ merchantId, feeBps })
// ════════════════════════════════════════════════════════════════════════════
exports.adminSetMerchantFee = onCall(
  { secrets: [adminKeySecret] },
  wrapError(async (request) => {
    requireAuth(request);
    const { merchantId, feeBps } = request.data ?? {};
    if (merchantId == null) throw new HttpsError('invalid-argument', 'merchantId가 필요합니다');
    const bps = feeBps != null ? Number(feeBps) : 1000;
    if (!Number.isFinite(bps) || bps < 0 || bps > 3000)
      throw new HttpsError('invalid-argument', 'feeBps는 0~3000(최대 30%) 사이여야 합니다');

    process.env.ADMIN_PRIVATE_KEY = adminKeySecret.value();
    const result = await txH.adminSetMerchantFeeOnChain(Number(merchantId), bps);
    logger.info('adminSetMerchantFee', result);
    return result;
  })
);

// ════════════════════════════════════════════════════════════════════════════
// 17-b. 관리자: 온체인 멘토 일괄 변경
//       클라이언트: httpsCallable(functions, 'adminBulkChangeMentor')({ mentorAddress, targetUids? })
// ════════════════════════════════════════════════════════════════════════════
exports.adminBulkChangeMentor = onCall(
  { secrets: [adminKeySecret] },
  wrapError(async (request) => {
    const uid = requireAuth(request);
    await requireAdmin(uid);
    const { mentorAddress, targetUids } = request.data ?? {};
    if (!mentorAddress) throw new HttpsError('invalid-argument', 'mentorAddress가 필요합니다');
    process.env.ADMIN_PRIVATE_KEY = adminKeySecret.value();
    const result = await txH.adminBulkChangeMentor(mentorAddress, targetUids || null);
    logger.info('adminBulkChangeMentor', { mentorAddress, ...result });
    return result;
  })
);

// ════════════════════════════════════════════════════════════════════════════
// 17-c. 관리자: 유저 온체인 레벨 설정
//       클라이언트: httpsCallable(functions, 'adminSetUserLevel')({ emailOrUid, level })
// ════════════════════════════════════════════════════════════════════════════
exports.adminSetUserLevel = onCall(
  { secrets: [adminKeySecret] },
  wrapError(async (request) => {
    const uid = requireAuth(request);
    await requireAdmin(uid);
    const { emailOrUid, level } = request.data ?? {};
    if (!emailOrUid) throw new HttpsError('invalid-argument', 'emailOrUid가 필요합니다');
    if (!Number.isInteger(Number(level)) || Number(level) < 1 || Number(level) > 10)
      throw new HttpsError('invalid-argument', '레벨은 1~10 사이 정수여야 합니다');
    process.env.ADMIN_PRIVATE_KEY = adminKeySecret.value();
    const result = await txH.adminSetUserLevel(emailOrUid, Number(level));
    logger.info('adminSetUserLevel', { adminUid: uid, ...result });
    return result;
  })
);

// ════════════════════════════════════════════════════════════════════════════
// 18. 나의 멘티 목록 조회
//     클라이언트: httpsCallable(functions, 'getMyMentees')()
// ════════════════════════════════════════════════════════════════════════════
exports.getMyMentees = onCall(
  wrapError(async (request) => {
    const uid = requireAuth(request);
    return await onboarding.getMyMentees(uid);
  })
);

// ════════════════════════════════════════════════════════════════════════════
// 19. 관리자: jumpPlatform 컨트랙트에 HEX 충전
//     - 관리자 지갑 HEX → ownerDepositHex() → 컨트랙트 HEX 풀 증가
//     - 사전 조건: adminApproveHex (무한 approve) 완료 상태
//     클라이언트: httpsCallable(functions, 'adminOwnerDepositHex')({ amountWei: '1000000000000000000' })
// ════════════════════════════════════════════════════════════════════════════
exports.adminOwnerDepositHex = onCall(
  { secrets: [adminKeySecret] },
  wrapError(async (request) => {
    requireAuth(request);
    const { amountWei } = request.data ?? {};
    if (!amountWei) throw new HttpsError('invalid-argument', 'amountWei가 필요합니다');

    process.env.ADMIN_PRIVATE_KEY = adminKeySecret.value();
    const result = await txH.adminOwnerDepositHex(String(amountWei));
    logger.info('adminOwnerDepositHex', result);
    return result;
  })
);

// ════════════════════════════════════════════════════════════════════════════
// 20. 가맹점 오프라인 결제
//     - 수탁 지갑 HEX → approve → jumpPlatform.payMerchantHex(merchantId, amountWei)
//     클라이언트: httpsCallable(functions, 'payMerchantHex')({ merchantId: 1, amountKrw: 50000 })
// ════════════════════════════════════════════════════════════════════════════
exports.payMerchantHex = onCall(
  { secrets: [walletSecret, adminKeySecret] },
  wrapError(async (request) => {
    const uid = requireAuth(request);
    const { merchantId, amountKrw, amountVnd, currency = 'KRW' } = request.data ?? {};
    if (merchantId == null) throw new HttpsError('invalid-argument', 'merchantId가 필요합니다');

    const cur = String(currency).toUpperCase();
    if (cur === 'VND') {
      if (!amountVnd || Number(amountVnd) < 10000)
        throw new HttpsError('invalid-argument', 'VND 최소 결제 금액은 10,000동입니다');
    } else {
      if (!amountKrw || Number(amountKrw) < 1000)
        throw new HttpsError('invalid-argument', '최소 결제 금액은 1,000원입니다');
    }

    process.env.ADMIN_PRIVATE_KEY = adminKeySecret.value();
    const result = await txH.payMerchantHexOnChain(
      uid, Number(merchantId), amountKrw ? Number(amountKrw) : 0, walletSecret.value(),
      { currency: cur, amountVnd: amountVnd ? Number(amountVnd) : undefined }
    );
    logger.info('payMerchantHex', { uid, merchantId, amountKrw, amountVnd, currency: cur, txHash: result.txHash });
    return result;
  })
);

// ════════════════════════════════════════════════════════════════════════════
// 21. 상품 HEX 즉시결제 (유저 수탁 지갑)
//     - 상품 가격(KRW/VND/USD) → 현재 환율로 HEX wei 환산
//     - approve → payMerchantHex (가맹점) 또는 직접 transfer (비가맹점)
//     - 주문 자동 confirmed 처리
//     클라이언트: httpsCallable(functions, 'payProductWithHex')({ itemId, date, people, phone, ... })
// ════════════════════════════════════════════════════════════════════════════
exports.payProductWithHex = onCall(
  { secrets: [walletSecret, adminKeySecret] },
  wrapError(async (request) => {
    const uid = requireAuth(request);
    const { itemId, date, startDate, endDate, people, phone, memo, bookingMode } = request.data ?? {};
    if (!itemId) throw new HttpsError('invalid-argument', 'itemId가 필요합니다');

    process.env.ADMIN_PRIVATE_KEY = adminKeySecret.value();
    const result = await txH.payProductWithHex(
      uid,
      { itemId, date, startDate, endDate, people, phone, memo, bookingMode },
      walletSecret.value()
    );
    logger.info('payProductWithHex', { uid, itemId, orderId: result.orderId, txHash: result.txHash });
    return result;
  })
);

// ════════════════════════════════════════════════════════════════════════════
// JUMP 거래소
// ════════════════════════════════════════════════════════════════════════════

// jumpBank 현황 조회 (가격, 잔액, 스테이킹, 배당)
exports.getJumpBankStatus = onCall(
  wrapError(async (request) => {
    const uid = requireAuth(request);
    return await exchangeH.getJumpBankStatus(uid);
  })
);

// JUMP 구매 (HEX → JUMP)
exports.buyJumpToken = onCall(
  { secrets: [walletSecret] },
  wrapError(async (request) => {
    const uid        = requireAuth(request);
    const jumpAmount = request.data?.jumpAmount;
    if (!jumpAmount) throw new HttpsError('invalid-argument', 'jumpAmount가 필요합니다');
    const result = await exchangeH.buyJumpToken(uid, jumpAmount, walletSecret.value());
    logger.info('buyJumpToken', { uid, jumpAmount, txHash: result.txHash });
    return result;
  })
);

// JUMP 판매 (JUMP → HEX)
exports.sellJumpToken = onCall(
  { secrets: [walletSecret] },
  wrapError(async (request) => {
    const uid        = requireAuth(request);
    const jumpAmount = request.data?.jumpAmount;
    if (!jumpAmount) throw new HttpsError('invalid-argument', 'jumpAmount가 필요합니다');
    const result = await exchangeH.sellJumpToken(uid, jumpAmount, walletSecret.value());
    logger.info('sellJumpToken', { uid, jumpAmount, txHash: result.txHash });
    return result;
  })
);

// JUMP 스테이킹
exports.stakeJumpToken = onCall(
  { secrets: [walletSecret] },
  wrapError(async (request) => {
    const uid        = requireAuth(request);
    const jumpAmount = request.data?.jumpAmount;
    if (!jumpAmount) throw new HttpsError('invalid-argument', 'jumpAmount가 필요합니다');
    const result = await exchangeH.stakeJumpToken(uid, jumpAmount, walletSecret.value());
    logger.info('stakeJumpToken', { uid, jumpAmount, txHash: result.txHash });
    return result;
  })
);

// JUMP 언스테이킹 (120일 락)
exports.unstakeJumpToken = onCall(
  { secrets: [walletSecret] },
  wrapError(async (request) => {
    const uid = requireAuth(request);
    const result = await exchangeH.unstakeJumpToken(uid, walletSecret.value());
    logger.info('unstakeJumpToken', { uid, txHash: result.txHash });
    return result;
  })
);

// 배당 청구 (HEX 수령)
exports.claimJumpDividend = onCall(
  { secrets: [walletSecret] },
  wrapError(async (request) => {
    const uid = requireAuth(request);
    const result = await exchangeH.claimJumpDividend(uid, walletSecret.value());
    logger.info('claimJumpDividend', { uid, hexAmount: result.hexAmount, txHash: result.txHash });
    return result;
  })
);

// ════════════════════════════════════════════════════════════════════════════
// BUT 토큰 (수탁 지갑)
// ════════════════════════════════════════════════════════════════════════════

// BUT 현황 조회 (가격, 잔액, 스테이킹, 배당 등)
exports.getButStatus = onCall(
  wrapError(async (request) => {
    const uid = requireAuth(request);
    return butTokenH.getButStatus(uid);
  })
);

// BUT 매수 (HEX → BUT)
exports.buyBut = onCall(
  { secrets: [walletSecret] },
  wrapError(async (request) => {
    const uid    = requireAuth(request);
    const amount = request.data?.amount;
    if (!amount) throw new HttpsError('invalid-argument', 'amount가 필요합니다');
    const result = await butTokenH.buyBut(uid, Number(amount), walletSecret.value());
    logger.info('buyBut', { uid, amount, txHash: result.txHash });
    return result;
  })
);

// BUT 매도 (BUT → HEX)
exports.sellBut = onCall(
  { secrets: [walletSecret] },
  wrapError(async (request) => {
    const uid    = requireAuth(request);
    const amount = request.data?.amount;
    if (!amount) throw new HttpsError('invalid-argument', 'amount가 필요합니다');
    const result = await butTokenH.sellBut(uid, Number(amount), walletSecret.value());
    logger.info('sellBut', { uid, amount, txHash: result.txHash });
    return result;
  })
);

// BUT 스테이킹
exports.stakeBut = onCall(
  { secrets: [walletSecret] },
  wrapError(async (request) => {
    const uid    = requireAuth(request);
    const amount = request.data?.amount;
    if (!amount) throw new HttpsError('invalid-argument', 'amount가 필요합니다');
    const result = await butTokenH.stakeBut(uid, Number(amount), walletSecret.value());
    logger.info('stakeBut', { uid, amount, txHash: result.txHash });
    return result;
  })
);

// BUT 스테이킹 출금 (락업 해제 후)
exports.withdrawBut = onCall(
  { secrets: [walletSecret] },
  wrapError(async (request) => {
    const uid = requireAuth(request);
    const result = await butTokenH.withdrawBut(uid, walletSecret.value());
    logger.info('withdrawBut', { uid, txHash: result.txHash });
    return result;
  })
);

// BUT 배당 청구
exports.claimButDividend = onCall(
  { secrets: [walletSecret] },
  wrapError(async (request) => {
    const uid = requireAuth(request);
    const result = await butTokenH.claimButDividend(uid, walletSecret.value());
    logger.info('claimButDividend', { uid, pendingWei: result.pendingWei, txHash: result.txHash });
    return result;
  })
);

// ════════════════════════════════════════════════════════════════════════════
// 레벨4+ HEX → 개인 지갑 이체
//    클라이언트: httpsCallable(functions, 'transferHexToPersonal')({ toAddress, amountWei })
//    amountWei: wei 단위 문자열 또는 "all" (전액)
// ════════════════════════════════════════════════════════════════════════════
exports.transferHexToPersonal = onCall(
  { secrets: [walletSecret, adminKeySecret] },
  wrapError(async (request) => {
    const uid = requireAuth(request);
    const { toAddress, amountWei } = request.data ?? {};
    if (!toAddress) throw new HttpsError('invalid-argument', 'toAddress가 필요합니다');
    if (!amountWei) throw new HttpsError('invalid-argument', 'amountWei가 필요합니다');

    process.env.ADMIN_PRIVATE_KEY = adminKeySecret.value();
    const result = await txH.transferHexToPersonal(
      uid, toAddress, String(amountWei), walletSecret.value()
    );
    logger.info('transferHexToPersonal', { uid, toAddress, amountHex: result.amountHex, txHash: result.txHash });
    return result;
  })
);

// ════════════════════════════════════════════════════════════════════════════
// [기존] 리뷰 평점 집계 (유지)
// ════════════════════════════════════════════════════════════════════════════
exports.aggregateItemReviews = onDocumentWritten(
  'items/{itemId}/reviews/{reviewId}',
  async (event) => {
    const itemId = event.params.itemId;
    const before = event.data?.before?.data() || null;
    const after  = event.data?.after?.data()  || null;
    if (!before && !after) return;

    const bRating = before?.rating != null ? Number(before.rating) : 0;
    const aRating = after?.rating  != null ? Number(after.rating)  : 0;
    const itemRef = db.collection('items').doc(itemId);

    await db.runTransaction(async (tx) => {
      const snap = await tx.get(itemRef);
      const cur  = snap.exists ? snap.data() : {};

      let count = Number(cur.reviewCount || 0);
      let sum   = Number(cur.reviewSum   || 0);

      if      (!before && after)  { count += 1; sum += aRating; }
      else if (before  && !after) { count = Math.max(0, count - 1); sum -= bRating; }
      else if (before  && after)  { sum += aRating - bRating; }

      if (!Number.isFinite(count) || count < 0) count = 0;
      if (!Number.isFinite(sum)   || sum   < 0) sum   = 0;

      const avg = count ? Math.round((sum / count) * 10) / 10 : 0;

      tx.set(itemRef, {
        reviewCount:     count,
        reviewSum:       sum,
        reviewAvg:       avg,
        reviewUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    });

    logger.info('aggregateItemReviews updated', { itemId, bRating, aRating });
  }
);

// ════════════════════════════════════════════════════════════════════════════
// 조합전용몰
// ════════════════════════════════════════════════════════════════════════════

exports.listCoopProducts = onCall(
  {},
  wrapError(async (request) => {
    const uid = requireAuth(request);
    return coopH.listCoopProducts(uid);
  })
);

exports.buyCoopProduct = onCall(
  { secrets: [walletSecret, adminKeySecret] },
  wrapError(async (request) => {
    const uid = requireAuth(request);
    const { productId } = request.data ?? {};
    if (!productId) throw new HttpsError('invalid-argument', 'productId가 필요합니다');
    process.env.ADMIN_PRIVATE_KEY = adminKeySecret.value();
    const result = await coopH.buyCoopProduct(uid, { productId }, walletSecret.value());
    logger.info('buyCoopProduct', { uid, productId, txHash: result.txHash });
    return result;
  })
);

exports.joinCoopMall = onCall(
  { secrets: [walletSecret, adminKeySecret] },
  wrapError(async (request) => {
    const uid = requireAuth(request);
    process.env.ADMIN_PRIVATE_KEY = adminKeySecret.value();
    const result = await coopH.joinCoopMall(uid, walletSecret.value());
    logger.info('joinCoopMall', { uid, txHash: result.txHash });
    return result;
  })
);

exports.convertCoopPoints = onCall(
  { secrets: [walletSecret, adminKeySecret] },
  wrapError(async (request) => {
    const uid = requireAuth(request);
    process.env.ADMIN_PRIVATE_KEY = adminKeySecret.value();
    const result = await coopH.convertCoopPoints(uid, walletSecret.value());
    logger.info('convertCoopPoints', { uid, txHash: result.txHash });
    return result;
  })
);

exports.adminSetCoopConfig = onCall(
  {},
  wrapError(async (request) => {
    const uid = requireAuth(request);
    return coopH.adminSetCoopConfig(uid, request.data ?? {});
  })
);

exports.adminSaveCoopProduct = onCall(
  {},
  wrapError(async (request) => {
    const uid = requireAuth(request);
    return coopH.adminSaveCoopProduct(uid, request.data ?? {});
  })
);

exports.adminDeleteCoopProduct = onCall(
  {},
  wrapError(async (request) => {
    const uid = requireAuth(request);
    return coopH.adminDeleteCoopProduct(uid, request.data ?? {});
  })
);

// ════════════════════════════════════════════════════════════════════════════
// ZaloPay 포인트 시스템
// ════════════════════════════════════════════════════════════════════════════

// 유저: HEX → Zalo포인트 즉시 전환 (2% 수수료 자동 처리, secrets 필요)
exports.requestZaloConvert = onCall(
  { secrets: [walletSecret, adminKeySecret] },
  wrapError(async (request) => {
    const uid = requireAuth(request);
    process.env.ADMIN_PRIVATE_KEY = adminKeySecret.value();
    return await zaloH.requestZaloConvert(uid, request.data ?? {}, walletSecret.value());
  })
);

// 유저: Zalo포인트 사용
exports.useZaloBalance = onCall(
  wrapError(async (request) => {
    const uid = requireAuth(request);
    return await zaloH.useZaloBalance(uid, request.data ?? {});
  })
);

// 관리자: 사용 내역 정산 완료 처리
exports.settleZaloUsage = onCall(
  wrapError(async (request) => {
    const adminUid = requireAuth(request);
    return await zaloH.settleZaloUsage(adminUid, request.data ?? {});
  })
);

// ════════════════════════════════════════════════════════════════════════════
// 외부 Web3 개발자용 파트너 API
//
// 인증: Header  X-Api-Key: {EXT_API_KEY}
//       또는 Query ?api_key={EXT_API_KEY}
//
// [엔드포인트]
//
// 1. 지갑 주소 조회 (이메일로)
//    GET /externalApi/wallet?email=user@example.com
//    Response: { ok, data: { walletAddress, level, mentor, createdAt } }
//
// 2. 지갑 주소 조회 (지갑 주소로 → Jump 회원 여부 확인)
//    GET /externalApi/wallet?address=0x...
//    Response: { ok, data: { walletAddress, level, mentor, createdAt } }
//
// 3. 배치 조회 (이메일 목록 → 지갑 주소 매핑)
//    POST /externalApi/wallets
//    Body: { emails: ['a@b.com', 'c@d.com'] }  (최대 50개)
//    Response: { ok, data: [ { email, walletAddress, level } ... ] }
//
// [API 키 발급]
//   firebase functions:secrets:set EXT_API_KEY
// ════════════════════════════════════════════════════════════════════════════
exports.externalApi = onRequest(
  { cors: false, secrets: [extApiSecret, walletSecret] },
  async (req, res) => {
    // ── CORS 헤더 직접 설정 (커스텀 헤더 X-Api-Key 허용) ──
    const origin = req.headers.origin || '*';
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, X-Api-Key, X-User-Token, Authorization');
    res.set('Access-Control-Max-Age', '3600');

    if (req.method === 'OPTIONS') {
      res.status(204).send('');
      return;
    }

    const path = req.path.replace(/^\//, '');

    // ── API 키 검증 (verifyUser / signMessage는 사용자 토큰 기반이라 제외) ──
    const publicPaths = ['verifyUser', 'signMessage']; // signTransaction은 내부에서 별도 API 키 검증
    if (!publicPaths.includes(path)) {
      const providedKey =
        req.headers['x-api-key'] ||
        req.body?.apiKey ||
        req.query.api_key ||
        '';

      logger.info('[externalApi] auth debug', {
        path,
        hasHeaderKey: !!req.headers['x-api-key'],
        hasBodyKey: !!req.body?.apiKey,
        bodyKeys: Object.keys(req.body || {}),
        providedKeyLen: providedKey.length,
        secretKeyLen: extApiSecret.value().length,
        match: providedKey === extApiSecret.value(),
      });

      if (!providedKey || providedKey !== extApiSecret.value()) {
        res.status(401).json({ ok: false, error: 'Invalid API key' });
        return;
      }
    }

    try {
      // ── 1 & 2: 단건 조회 GET /wallet ──────────────────────────────
      if (req.method === 'GET' && path === 'wallet') {
        const { email, address } = req.query;

        if (!email && !address) {
          res.status(400).json({ ok: false, error: 'email 또는 address 파라미터가 필요합니다' });
          return;
        }

        let uid = null;

        if (email) {
          // 이메일로 Firebase Auth UID 조회
          try {
            const userRecord = await admin.auth().getUserByEmail(String(email).trim().toLowerCase());
            uid = userRecord.uid;
          } catch (_) {
            res.status(404).json({ ok: false, error: '해당 이메일로 가입된 회원을 찾을 수 없습니다' });
            return;
          }
        } else {
          // 지갑 주소로 Firestore 조회
          const addr = String(address).trim().toLowerCase();
          const snap = await db.collection('users')
            .where('wallet.address', '==', addr)
            .limit(1)
            .get();
          if (snap.empty) {
            res.status(404).json({ ok: false, error: '해당 주소로 가입된 회원을 찾을 수 없습니다' });
            return;
          }
          uid = snap.docs[0].id;
        }

        const userSnap = await db.collection('users').doc(uid).get();
        if (!userSnap.exists) {
          res.status(404).json({ ok: false, error: '회원 정보를 찾을 수 없습니다' });
          return;
        }

        const data = userSnap.data();
        const walletAddress = data?.wallet?.address || null;

        if (!walletAddress) {
          res.status(404).json({ ok: false, error: '수탁 지갑이 아직 생성되지 않았습니다' });
          return;
        }

        res.json({
          ok: true,
          data: {
            walletAddress,
            level:     data?.onChain?.level     ?? null,
            mentor:    data?.onChain?.mentor     ?? null,
            createdAt: data?.createdAt?.toDate?.()?.toISOString?.() ?? null,
          },
        });
        return;
      }

      // ── 3: 배치 조회 POST /wallets ─────────────────────────────────
      if (req.method === 'POST' && path === 'wallets') {
        const emails = req.body?.emails;
        if (!Array.isArray(emails) || emails.length === 0) {
          res.status(400).json({ ok: false, error: 'emails 배열이 필요합니다' });
          return;
        }
        if (emails.length > 50) {
          res.status(400).json({ ok: false, error: '한 번에 최대 50개까지 조회할 수 있습니다' });
          return;
        }

        const results = await Promise.all(
          emails.map(async (em) => {
            const emailStr = String(em).trim().toLowerCase();
            try {
              const userRecord = await admin.auth().getUserByEmail(emailStr);
              const userSnap = await db.collection('users').doc(userRecord.uid).get();
              const data = userSnap.exists ? userSnap.data() : null;
              const walletAddress = data?.wallet?.address || null;
              return {
                email: emailStr,
                walletAddress,
                level:  data?.onChain?.level  ?? null,
                mentor: data?.onChain?.mentor ?? null,
                found:  !!walletAddress,
              };
            } catch (_) {
              return { email: emailStr, walletAddress: null, level: null, mentor: null, found: false };
            }
          })
        );

        res.json({ ok: true, data: results });
        return;
      }

      // ── 4: 유저 토큰으로 지갑 주소 확인 POST /verifyUser ──────────
      // 파트너 API 키 불필요. 유저가 직접 자신의 Firebase ID Token을 보냄.
      // 파트너 사이트: 유저 Google 로그인 → ID Token → 이 엔드포인트 호출
      if (req.method === 'POST' && path === 'verifyUser') {
        const userToken = (req.headers['x-user-token'] || req.body?.userToken || req.body?.idToken || '');
        if (!userToken) {
          res.status(400).json({ ok: false, error: 'idToken(또는 userToken) 필드가 필요합니다' });
          return;
        }
        let decoded;
        try {
          decoded = await admin.auth().verifyIdToken(userToken);
        } catch (_) {
          res.status(401).json({ ok: false, error: '유효하지 않은 사용자 토큰입니다' });
          return;
        }
        const userSnap = await db.collection('users').doc(decoded.uid).get();
        if (!userSnap.exists) {
          res.status(404).json({ ok: false, error: 'Jump 미가입 회원입니다' });
          return;
        }
        const data = userSnap.data();
        const walletAddress = data?.wallet?.address || null;
        if (!walletAddress) {
          res.status(404).json({ ok: false, error: '수탁 지갑이 아직 생성되지 않았습니다' });
          return;
        }
        res.json({
          ok: true,
          data: {
            walletAddress,
            level:     data?.onChain?.level  ?? null,
            mentor:    data?.onChain?.mentor ?? null,
            createdAt: data?.createdAt?.toDate?.()?.toISOString?.() ?? null,
          },
        });
        return;
      }

      // ── 5: 메시지 서명 위임 POST /signMessage ──────────────────────
      // 파트너 API 키 + 유저 토큰 모두 필요.
      // 파트너가 특정 메시지를 수탁 지갑으로 서명 요청 (EIP-191 개인 서명).
      // 보안: 서명 가능 메시지는 100자 이내 평문만 허용 (임의 트랜잭션 불가).
      if (req.method === 'POST' && path === 'signMessage') {
        const userToken = (req.headers['x-user-token'] || req.body?.userToken || req.body?.idToken || '');
        const message   = String(req.body?.message || '').trim();

        if (!userToken) {
          res.status(400).json({ ok: false, error: 'idToken(또는 userToken) 필드가 필요합니다' });
          return;
        }
        if (!message || message.length > 200) {
          res.status(400).json({ ok: false, error: 'message는 1~200자 평문이어야 합니다' });
          return;
        }

        let decoded;
        try {
          decoded = await admin.auth().verifyIdToken(userToken);
        } catch (_) {
          res.status(401).json({ ok: false, error: '유효하지 않은 사용자 토큰입니다' });
          return;
        }

        const userSnap = await db.collection('users').doc(decoded.uid).get();
        if (!userSnap.exists) {
          res.status(404).json({ ok: false, error: 'Jump 미가입 회원입니다' });
          return;
        }
        const data = userSnap.data();
        const encryptedKey = data?.wallet?.encryptedKey;
        const walletAddress = data?.wallet?.address;
        if (!encryptedKey || !walletAddress) {
          res.status(404).json({ ok: false, error: '수탁 지갑이 없습니다' });
          return;
        }

        // 수탁 지갑 복호화 후 서명
        const { ethers } = require('ethers');
        const { decrypt } = require('./wallet/crypto');
        const privateKey = decrypt(encryptedKey, walletSecret.value());
        const signer = new ethers.Wallet(privateKey);
        const signature = await signer.signMessage(message);

        logger.info('signMessage', { uid: decoded.uid, walletAddress, messageLen: message.length });
        res.json({
          ok: true,
          data: { walletAddress, signature, message },
        });
        return;
      }

      // ── 6: 트랜잭션 서명 + 브로드캐스트 POST /signTransaction ──────
      // 파트너 API 키 + 유저 idToken 모두 필요.
      // opBNB Mainnet에서 사용자 수탁 지갑으로 실제 트랜잭션을 전송한다.
      //
      // tx.type 별 Body 예시:
      //   ETH 전송:    { type:"eth",      to:"0x...", value:"1000000000000000000" }
      //   ERC-20:      { type:"erc20",    tokenAddress:"0x...", to:"0x...", amount:"1000000000000000000" }
      //   컨트랙트 호출: { type:"contract", to:"0x...", abi:[...], method:"fn", args:[...], value:"0" }
      if (req.method === 'POST' && path === 'signTransaction') {
        // ① API 키 재확인 (publicPaths에 포함되어 위에서 건너뛰었으므로 여기서 직접 검증)
        const apiKey = req.headers['x-api-key'] || req.body?.apiKey || req.query.api_key || '';
        if (!apiKey || apiKey !== extApiSecret.value()) {
          res.status(401).json({ ok: false, error: 'Invalid API key' });
          return;
        }

        // ② 유저 토큰 검증
        const userToken = (req.headers['x-user-token'] || req.body?.idToken || req.body?.userToken || '');
        if (!userToken) {
          res.status(400).json({ ok: false, error: 'idToken 필드가 필요합니다' });
          return;
        }
        let decoded;
        try {
          decoded = await admin.auth().verifyIdToken(userToken);
        } catch (_) {
          res.status(401).json({ ok: false, error: '유효하지 않은 사용자 토큰입니다' });
          return;
        }

        // ③ 수탁 지갑 조회
        const userSnap = await db.collection('users').doc(decoded.uid).get();
        if (!userSnap.exists) {
          res.status(404).json({ ok: false, error: 'Jump 미가입 회원입니다' });
          return;
        }
        const data = userSnap.data();
        const encryptedKey = data?.wallet?.encryptedKey;
        const walletAddress = data?.wallet?.address;
        if (!encryptedKey || !walletAddress) {
          res.status(404).json({ ok: false, error: '수탁 지갑이 없습니다' });
          return;
        }

        // ④ 트랜잭션 파라미터 검증
        const tx = req.body?.tx;
        if (!tx || !tx.type) {
          res.status(400).json({ ok: false, error: 'tx.type이 필요합니다 (eth | erc20 | contract)' });
          return;
        }
        if (!['eth', 'erc20', 'contract'].includes(tx.type)) {
          res.status(400).json({ ok: false, error: 'tx.type은 eth, erc20, contract 중 하나여야 합니다' });
          return;
        }

        // ⑤ 지갑 복호화 + provider 연결
        const { ethers } = require('ethers');
        const { decrypt } = require('./wallet/crypto');
        const { getProvider } = require('./wallet/chain');
        const privateKey = decrypt(encryptedKey, walletSecret.value());
        const signer = new ethers.Wallet(privateKey, getProvider());

        let txResponse;

        if (tx.type === 'eth') {
          // ETH 전송
          if (!tx.to || !tx.value) {
            res.status(400).json({ ok: false, error: 'tx.to, tx.value가 필요합니다' });
            return;
          }
          txResponse = await signer.sendTransaction({
            to: tx.to,
            value: BigInt(tx.value),
            ...(tx.gasLimit ? { gasLimit: BigInt(tx.gasLimit) } : {}),
          });

        } else if (tx.type === 'erc20') {
          // ERC-20 전송
          if (!tx.tokenAddress || !tx.to || !tx.amount) {
            res.status(400).json({ ok: false, error: 'tx.tokenAddress, tx.to, tx.amount가 필요합니다' });
            return;
          }
          const erc20 = new ethers.Contract(
            tx.tokenAddress,
            ['function transfer(address to, uint256 amount) returns (bool)'],
            signer
          );
          txResponse = await erc20.transfer(tx.to, BigInt(tx.amount),
            tx.gasLimit ? { gasLimit: BigInt(tx.gasLimit) } : {}
          );

        } else {
          // 컨트랙트 호출
          if (!tx.to || !tx.abi || !tx.method) {
            res.status(400).json({ ok: false, error: 'tx.to, tx.abi, tx.method가 필요합니다' });
            return;
          }
          const contract = new ethers.Contract(tx.to, tx.abi, signer);
          const args = Array.isArray(tx.args) ? tx.args : [];
          const overrides = {};
          if (tx.value)    overrides.value    = BigInt(tx.value);
          if (tx.gasLimit) overrides.gasLimit = BigInt(tx.gasLimit);
          txResponse = await contract[tx.method](...args, ...(Object.keys(overrides).length ? [overrides] : []));
        }

        // ⑥ Firestore 감사 로그
        await db.collection('partner_tx_logs').add({
          uid:         decoded.uid,
          walletAddress,
          txType:      tx.type,
          txHash:      txResponse.hash,
          to:          tx.to || null,
          createdAt:   admin.firestore.FieldValue.serverTimestamp(),
        });

        logger.info('signTransaction', { uid: decoded.uid, walletAddress, txType: tx.type, txHash: txResponse.hash });
        res.json({
          ok: true,
          data: {
            txHash:  txResponse.hash,
            from:    walletAddress,
            txType:  tx.type,
          },
        });
        return;
      }

      res.status(404).json({ ok: false, error: '지원하지 않는 엔드포인트입니다' });
    } catch (err) {
      logger.error('[externalApi Error]', err);
      res.status(500).json({ ok: false, error: err.message || '서버 오류' });
    }
  }
);

// ════════════════════════════════════════════════════════════════════════════
// DAO 의결 시스템
// ════════════════════════════════════════════════════════════════════════════

// 안건 심의 등록 (JUMP 1만개 이상 스테이킹 필요)
exports.daoCreateProposal = onCall(
  wrapError(async (request) => {
    const uid = requireAuth(request);
    return daoH.createProposal(uid, request.data);
  })
);

// 관리자 승인
exports.daoAdminApproveProposal = onCall(
  wrapError(async (request) => {
    const uid = requireAuth(request);
    return daoH.adminApproveProposal(uid, request.data);
  })
);

// 관리자 반려
exports.daoAdminRejectProposal = onCall(
  wrapError(async (request) => {
    const uid = requireAuth(request);
    return daoH.adminRejectProposal(uid, request.data);
  })
);

// 안건 지지 (누적 25만 달성 시 의결 전환)
exports.daoSupportProposal = onCall(
  wrapError(async (request) => {
    const uid = requireAuth(request);
    return daoH.supportProposal(uid, request.data);
  })
);

// 투표 (찬성/반대, 과반 달성 시 즉시 의결)
exports.daoVoteProposal = onCall(
  wrapError(async (request) => {
    const uid = requireAuth(request);
    return daoH.voteProposal(uid, request.data);
  })
);

// 안건 삭제 (pending_admin, 작성자/관리자)
exports.daoDeleteProposal = onCall(
  wrapError(async (request) => {
    const uid = requireAuth(request);
    return daoH.deleteProposal(uid, request.data);
  })
);

// 안건 수정 (pending_admin, 작성자/관리자)
exports.daoUpdateProposal = onCall(
  wrapError(async (request) => {
    const uid = requireAuth(request);
    return daoH.updateProposal(uid, request.data);
  })
);

// 댓글 (JUMP 1만개 이상 스테이킹 필요)
exports.daoCommentProposal = onCall(
  wrapError(async (request) => {
    const uid = requireAuth(request);
    return daoH.commentProposal(uid, request.data);
  })
);

// DAO 10일 만료 자동 부결 — 매일 오전 9시 (UTC+7 기준 02:00 UTC)
exports.daoAutoRejectExpired = onSchedule('every 24 hours', async () => {
  await daoH.autoRejectExpiredProposals();
});

// ════════════════════════════════════════════════════════════════════════════
// 보물찾기 시스템
// ════════════════════════════════════════════════════════════════════════════

exports.collectTreasureBox = onCall(wrapError(async (req) => {
  return treasureH.collectTreasureBox(requireAuth(req), req.data ?? {});
}));

exports.openTreasureBox = onCall(wrapError(async (req) => {
  return treasureH.openTreasureBox(requireAuth(req), req.data ?? {});
}));

exports.adminCollectTreasureBox = onCall(wrapError(async (req) => {
  return treasureH.adminCollectTreasureBox(requireAuth(req), req.data ?? {});
}));

exports.craftVoucher = onCall(wrapError(async (req) => {
  return treasureH.craftVoucher(requireAuth(req), req.data ?? {});
}));

exports.adminSaveTreasureItem = onCall(wrapError(async (req) => {
  return treasureH.adminSaveTreasureItem(requireAuth(req), req.data ?? {});
}));

exports.adminSaveTreasureBox = onCall(wrapError(async (req) => {
  return treasureH.adminSaveTreasureBox(requireAuth(req), req.data ?? {});
}));

exports.adminDeleteTreasureBox = onCall(wrapError(async (req) => {
  return treasureH.adminDeleteTreasureBox(requireAuth(req), req.data ?? {});
}));

exports.adminSaveVoucher = onCall(wrapError(async (req) => {
  return treasureH.adminSaveVoucher(requireAuth(req), req.data ?? {});
}));

exports.adminGrantItem = onCall(wrapError(async (req) => {
  return treasureH.adminGrantItem(requireAuth(req), req.data ?? {});
}));

exports.usePotion = onCall(wrapError(async (req) => {
  return treasureH.usePotion(requireAuth(req));
}));

exports.useMpPotion = onCall(wrapError(async (req) => {
  return treasureH.useMpPotion(requireAuth(req));
}));

exports.useReviveTicket = onCall(wrapError(async (req) => {
  return treasureH.useReviveTicket(requireAuth(req));
}));

// 관리자: 빨간약 직접 지급
exports.adminGivePotion = onCall(wrapError(async (req) => {
  const adminUid = requireAuth(req);
  await requireAdmin(adminUid);
  const { targetUid, count = 1 } = req.data ?? {};
  if (!targetUid) throw new HttpsError('invalid-argument', 'targetUid가 필요합니다');
  const n = Math.max(1, Math.floor(Number(count)));
  const db = admin.firestore();
  const invRef = db.collection('treasure_inventory').doc(`${targetUid}_potion_red`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(invRef);
    const current = snap.exists ? (snap.data().count || 0) : 0;
    tx.set(invRef, {
      uid: targetUid, itemId: 'potion_red', count: current + n,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  });
  return { ok: true, given: n };
}));

exports.adminGiveRevive = onCall(wrapError(async (req) => {
  const adminUid = requireAuth(req);
  await requireAdmin(adminUid);
  const { targetUid, count = 1 } = req.data ?? {};
  if (!targetUid) throw new HttpsError('invalid-argument', 'targetUid가 필요합니다');
  const n = Math.max(1, Math.floor(Number(count)));
  const db = admin.firestore();
  const invRef = db.collection('treasure_inventory').doc(`${targetUid}_revive_ticket`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(invRef);
    const current = snap.exists ? (snap.data().count || 0) : 0;
    tx.set(invRef, {
      uid: targetUid, itemId: 'revive_ticket', count: current + n,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  });
  return { ok: true, given: n };
}));

// ════════════════════════════════════════════════════════════════════════════
// 소셜 커뮤니티 – 행사 바우처
// ════════════════════════════════════════════════════════════════════════════

exports.checkEventEligibility = onCall(wrapError(async (req) => {
  const uid = requireAuth(req);
  return communityH.checkEventEligibility(uid, req.data ?? {});
}));

exports.getMyEventVoucher = onCall(wrapError(async (req) => {
  const uid = requireAuth(req);
  return communityH.getMyEventVoucher(uid, req.data ?? {});
}));

exports.buyEventVoucher = onCall(
  { secrets: [walletSecret, adminKeySecret] },
  wrapError(async (req) => {
    const uid = requireAuth(req);
    process.env.ADMIN_PRIVATE_KEY = adminKeySecret.value();
    const result = await communityH.buyEventVoucher(uid, req.data ?? {}, walletSecret.value());
    logger.info('buyEventVoucher', { uid, eventId: req.data?.eventId, txHash: result.txHash });
    return result;
  })
);

exports.confirmVoucher = onCall(wrapError(async (req) => {
  const uid = requireAuth(req);
  return communityH.confirmVoucher(uid, req.data ?? {});
}));

// ════════════════════════════════════════════════════════════════════════════
// 버기카 호출 서비스 (그린)
// ════════════════════════════════════════════════════════════════════════════
// requestRide: HEX 잔액 온체인 조회 필요 (adminKeySecret → getProvider 내부)
exports.buggyRequestRide = onCall(
  { secrets: [walletSecret, adminKeySecret] },
  wrapError(async (req) => {
    const uid = requireAuth(req);
    process.env.ADMIN_PRIVATE_KEY = adminKeySecret.value();
    return buggyH.requestRide(uid, req.data ?? {});
  })
);
exports.buggyCancelRide = onCall(wrapError(async (req) => {
  const uid = requireAuth(req);
  return buggyH.cancelRide(uid, req.data ?? {});
}));
exports.buggyAcceptRide = onCall(wrapError(async (req) => {
  const uid = requireAuth(req);
  return buggyH.acceptRide(uid, req.data ?? {});
}));
exports.buggyDriverArrive = onCall(wrapError(async (req) => {
  const uid = requireAuth(req);
  return buggyH.driverArrive(uid, req.data ?? {});
}));
// startRide: 탑승 시작 전 HEX 잔액 재확인
exports.buggyStartRide = onCall(
  { secrets: [walletSecret, adminKeySecret] },
  wrapError(async (req) => {
    const uid = requireAuth(req);
    process.env.ADMIN_PRIVATE_KEY = adminKeySecret.value();
    return buggyH.startRide(uid, req.data ?? {});
  })
);
// endRide: HEX 온체인 결제 실행
exports.buggyEndRide = onCall(
  { secrets: [walletSecret, adminKeySecret] },
  wrapError(async (req) => {
    const uid = requireAuth(req);
    process.env.ADMIN_PRIVATE_KEY = adminKeySecret.value();
    return buggyH.endRide(uid, req.data ?? {}, walletSecret.value());
  })
);
exports.buggyUpdateDriverLocation = onCall(wrapError(async (req) => {
  const uid = requireAuth(req);
  return buggyH.updateDriverLocation(uid, req.data ?? {});
}));
exports.buggySetDriverOnline = onCall(wrapError(async (req) => {
  const uid = requireAuth(req);
  return buggyH.setDriverOnline(uid, req.data ?? {});
}));
exports.buggyAdminCreateDriver = onCall(wrapError(async (req) => {
  const uid = requireAuth(req);
  return buggyH.adminCreateDriver(uid, req.data ?? {});
}));
exports.buggyAdminForceEnd = onCall(
  { secrets: [walletSecret, adminKeySecret] },
  wrapError(async (req) => {
    const uid = requireAuth(req);
    process.env.ADMIN_PRIVATE_KEY = adminKeySecret.value();
    return buggyH.adminForceEnd(uid, req.data ?? {}, walletSecret.value());
  })
);
exports.buggyAdminSaveConfig = onCall(wrapError(async (req) => {
  const uid = requireAuth(req);
  return buggyH.adminSaveConfig(uid, req.data ?? {});
}));
exports.buggyGetDriverEarnings = onCall(wrapError(async (req) => {
  const uid = requireAuth(req);
  return buggyH.getDriverEarnings(uid, req.data ?? {});
}));
exports.buggyGetConfig = onCall(wrapError(async (_req) => {
  return buggyH.getConfig();
}));
