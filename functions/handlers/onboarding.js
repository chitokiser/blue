// functions/handlers/onboarding.js
// 수탁 지갑 생성 / 온체인 가입 / 멘토 등록

'use strict';

const admin  = require('firebase-admin');
const { ethers } = require('ethers');
const { encrypt, decrypt } = require('../wallet/crypto');
const {
  getProvider,
  getPlatformContract,
  getHexContract,
  getAdminWallet,
  walletFromKey,
  estimateGasWithBuffer,
} = require('../wallet/chain');

const db = admin.firestore();

// ────────────────────────────────────────────────
// 수탁 지갑 생성
// ────────────────────────────────────────────────

/**
 * createCustodialWallet
 * - Firebase UID 1개 → ETH 지갑 1개 (멱등: 이미 있으면 기존 주소 반환)
 * - private key는 AES-256-GCM 암호화 후 Firestore에만 저장
 *
 * @param {string} uid         - Firebase Auth UID
 * @param {string} masterSecret - WALLET_MASTER_SECRET (Secret Manager에서 주입)
 * @returns {{ address: string, created: boolean }}
 */
async function createCustodialWallet(uid, masterSecret, mentorAddress) {
  // 멘토 주소 필수 검증 (지갑 생성 전에 차단)
  if (!mentorAddress || !ethers.isAddress(mentorAddress)) {
    throw new Error('멘토 지갑 주소가 필요합니다. 멘토 없이는 지갑을 생성할 수 없습니다.');
  }

  const userRef = db.collection('users').doc(uid);
  const snap    = await userRef.get();

  // 멱등: 수탁 지갑(encryptedKey 포함)이 이미 있으면 그대로 반환
  // MetaMask 등 개인지갑(address만 있고 encryptedKey 없음)은 재생성 허용
  if (snap.exists && snap.data()?.wallet?.address && snap.data()?.wallet?.encryptedKey) {
    return { address: snap.data().wallet.address, created: false };
  }

  // 이메일 기반 기존 수탁 지갑 탐색 (다른 배포에서 같은 이메일로 만든 지갑 재활용)
  const email = snap.data()?.email;
  if (email) {
    const dup = await db.collection('users')
      .where('email', '==', email)
      .where('wallet.encryptedKey', '!=', null)
      .limit(1)
      .get();

    if (!dup.empty) {
      const sourceDoc  = dup.docs[0];
      const sourceData = sourceDoc.data().wallet;
      // 주소만 연결 — private key는 원본 UID가 관리하므로 복사하지 않음
      await userRef.set({
        wallet: {
          address:      sourceData.address,
          linkedFrom:   sourceDoc.id,
          linkedAt:     admin.firestore.FieldValue.serverTimestamp(),
        },
      }, { merge: true });
      return { address: sourceData.address, created: false, linked: true };
    }
  }

  // 새 지갑 생성
  const wallet       = ethers.Wallet.createRandom();
  const encryptedKey = encrypt(wallet.privateKey, masterSecret);

  await userRef.set({
    wallet: {
      address:      wallet.address,
      encryptedKey,                        // 평문 key는 절대 저장 안 함
      createdAt:    admin.firestore.FieldValue.serverTimestamp(),
    },
  }, { merge: true });

  try {
    const provider    = getProvider();
    const adminWallet = getAdminWallet();

    // 1) 수탁 지갑에 가스비 BNB 소량 전송
    const fundTx = await adminWallet.sendTransaction({
      to:    wallet.address,
      value: ethers.parseEther('0.0001'),
    });
    await fundTx.wait();

    // 2) 수탁 지갑으로 register(mentorAddress)
    const signer   = walletFromKey(wallet.privateKey, provider);
    const platform = getPlatformContract(signer);
    const gasLimit = await estimateGasWithBuffer(platform, 'register', [mentorAddress]);
    const regTx    = await platform.register(mentorAddress, { gasLimit });
    await regTx.wait();

    // 3) Firestore 온체인 상태 기록
    await userRef.set({
      onChain: {
        registered:    true,
        registeredAt:  admin.firestore.FieldValue.serverTimestamp(),
        mentorAddress,
        txHash:        regTx.hash,
      },
    }, { merge: true });

    return { address: wallet.address, created: true, registered: true };
  } catch (regErr) {
    console.warn('[createCustodialWallet] 온체인 자동 등록 실패:', regErr.message);
    return { address: wallet.address, created: true, registered: false };
  }
}

// ────────────────────────────────────────────────
// 온체인 가입 (register)
// ────────────────────────────────────────────────

/**
 * registerOnChain
 * 1. user의 수탁 지갑으로 jumpPlatform.register(mentorAddress) 서명 + 전송
 * 2. mentorAddress(0x...)는 필수 — 없으면 에러
 *
 * @param {string}  uid           - Firebase Auth UID
 * @param {string}  mentorAddress - 멘토 지갑 주소 (0x로 시작하는 42자리)
 * @param {string}  masterSecret  - WALLET_MASTER_SECRET
 * @returns {{ txHash, address, mentorAddress }}
 */
async function registerOnChain(uid, mentorAddress, masterSecret) {
  // 멘토 주소 필수 검증
  if (!mentorAddress || !ethers.isAddress(mentorAddress)) {
    throw new Error('멘토 지갑 주소가 올바르지 않습니다. 0x로 시작하는 42자리 주소를 입력하세요.');
  }

  // 수탁 지갑 정보 조회
  const userSnap   = await db.collection('users').doc(uid).get();
  const walletData = userSnap.data()?.wallet;
  if (!walletData?.encryptedKey) {
    throw new Error('수탁 지갑이 없습니다. 먼저 지갑을 생성해주세요 (createWallet 호출)');
  }

  // 이미 가입했는지 확인 (체인이 진실 — Firestore 캐시는 무시)
  const providerCheck  = getProvider();
  const platformCheck  = getPlatformContract(providerCheck);
  const [currentLevel] = await platformCheck.members(walletData.address);
  if (Number(currentLevel) > 0) {
    // 체인에 이미 등록 → Firestore가 stale이면 동기화
    await db.collection('users').doc(uid).set(
      { onChain: { registered: true } },
      { merge: true }
    );
    throw new Error('이미 온체인 가입이 완료된 계정입니다');
  }

  // 수탁 지갑으로 서명
  const privateKey = decrypt(walletData.encryptedKey, masterSecret);
  const provider   = getProvider();
  const signer     = walletFromKey(privateKey, provider);
  const platform   = getPlatformContract(signer);

  // 가스 추정 + 10% 여유
  const gasLimit = await estimateGasWithBuffer(platform, 'register', [mentorAddress]);
  const tx       = await platform.register(mentorAddress, { gasLimit });
  const receipt  = await tx.wait();

  // Firestore 업데이트
  await db.collection('users').doc(uid).set({
    onChain: {
      registered:    true,
      registeredAt:  admin.firestore.FieldValue.serverTimestamp(),
      mentorAddress,
      txHash:        receipt.hash,
    },
  }, { merge: true });

  return {
    txHash:        receipt.hash,
    address:       walletData.address,
    mentorAddress,
  };
}

// ────────────────────────────────────────────────
// 멘토 등록 (이메일 ↔ 지갑 주소 연결)
// ────────────────────────────────────────────────

/**
 * registerMentor
 * 멘토가 Google OAuth로 이메일 인증 후,
 * 자신의 지갑으로 서명(EIP-191)하여 소유 증명 → DB에 email↔address 저장
 *
 * 서명 메시지 형식 (프론트에서 동일하게 생성해야 함):
 *   "Jump Platform 멘토 등록\nEmail: {email_lowercase}"
 *
 * @param {string} email     - Google OAuth 인증된 이메일
 * @param {string} address   - 멘토의 개인 지갑 주소
 * @param {string} signature - EIP-191 서명
 * @returns {{ success: boolean, address: string }}
 */
async function registerMentor(email, address, signature) {
  if (!email || !address || !signature) {
    throw new Error('email, address, signature 모두 필요합니다');
  }

  const normalEmail = email.toLowerCase().trim();

  // 서명 검증 (주소 소유 증명)
  const message = `Jump Platform 멘토 등록\nEmail: ${normalEmail}`;
  let recovered;
  try {
    recovered = ethers.verifyMessage(message, signature);
  } catch {
    throw new Error('서명 형식이 올바르지 않습니다');
  }

  if (recovered.toLowerCase() !== address.toLowerCase()) {
    throw new Error('서명 검증 실패: 제공된 주소와 서명 주소가 다릅니다');
  }

  // 온체인에서 level 4+ 확인
  const provider = getProvider();
  const platform = getPlatformContract(provider);
  // members() 반환: (level, mentor, exp, points, blocked)
  const [level]  = await platform.members(address);

  if (Number(level) < 4) {
    throw new Error(
      `멘토 등록 조건 미충족: 레벨 4 이상 필요. 현재 레벨: ${level}`
    );
  }

  // DB 저장
  await db.collection('mentors').doc(normalEmail).set({
    email:      normalEmail,
    address,
    level:      Number(level),
    verifiedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return { success: true, address };
}

// ────────────────────────────────────────────────
// 온체인 회원 정보 조회
// ────────────────────────────────────────────────

/**
 * getUserOnChainData
 * jumpPlatform.getMember() 조회 + 원화(KRW) 환산 포함
 *
 * @param {string} uid - Firebase Auth UID
 * @returns {{ address, level, mentor, pointWei, payableWei, joinAt, blocked,
 *             pointDisplay, payableDisplay, pointKrw, payableKrw, krwPerUsd }}
 */
async function getUserOnChainData(uid) {
  const userSnap = await db.collection('users').doc(uid).get();
  const address  = userSnap.data()?.wallet?.address;
  if (!address) throw new Error('수탁 지갑이 없습니다');

  const provider    = getProvider();
  const platform    = getPlatformContract(provider);
  const hexContract = getHexContract(provider);
  const { fetchExchangeRates } = require('../wallet/exchange');

  // 온체인 조회 + 환율 조회 + 지갑 HEX 잔액 병렬 실행
  // members() 반환: (uint32 level, address mentor, uint256 exp, uint256 points, bool blocked)
  const [[level, mentor, exp, points, blocked], ratesResult, walletHexBal] =
    await Promise.all([
      platform.members(address),
      fetchExchangeRates().catch(() => null),
      hexContract.balanceOf(address),
    ]);

  const krwPerUsd = ratesResult?.krwPerUsd ?? null;
  const vndPerUsd = ratesResult?.vndPerUsd ?? null;

  // HEX wei → 각 통화 환산 (환율 없으면 null)
  const hexToKrw = (wei) => {
    if (!krwPerUsd) return null;
    return Math.round(parseFloat(ethers.formatEther(wei)) * krwPerUsd);
  };
  const hexToVnd = (wei) => {
    if (!vndPerUsd) return null;
    return Math.round(parseFloat(ethers.formatEther(wei)) * vndPerUsd);
  };
  const hexToUsd = (wei) => {
    return Math.round(parseFloat(ethers.formatEther(wei)) * 100) / 100;
  };

  // EXP는 wei 단위가 아닌 순수 카운터 (fee / 1e16)
  const expNum      = Number(exp);
  const levelNum    = Number(level);
  const requiredExp = levelNum > 0 ? levelNum * levelNum * 10000 : 10000;

  return {
    address,
    level:   levelNum,
    mentor,
    exp:     expNum,
    requiredExp,
    blocked,
    // 포인트 (HEX wei 단위)
    pointWei:     points.toString(),
    pointDisplay: parseFloat(ethers.formatEther(points)).toFixed(4),
    pointKrw:     hexToKrw(points),
    pointVnd:     hexToVnd(points),
    pointUsd:     hexToUsd(points),
    // 수탁 지갑 실제 HEX 잔액 (P2P 수령 포함)
    walletHexWei:     walletHexBal.toString(),
    walletHexDisplay: parseFloat(ethers.formatEther(walletHexBal)).toFixed(4),
    walletHexKrw:     hexToKrw(walletHexBal),
    walletHexUsd:     hexToUsd(walletHexBal),
    walletHexVnd:     hexToVnd(walletHexBal),
    krwPerUsd,
    vndPerUsd,
  };
}

// ────────────────────────────────────────────────
// 나의 멘티 목록 조회
// ────────────────────────────────────────────────

/**
 * getMyMentees
 * Firestore에서 onChain.mentorAddress == myAddress 인 유저 목록 반환
 *
 * @param {string} uid - Firebase Auth UID
 * @returns {{ mentees: Array, myAddress: string|null }}
 */
async function getMyMentees(uid) {
  const userSnap = await db.collection('users').doc(uid).get();
  const userData = userSnap.data() || {};
  const myAddress = userData?.wallet?.address;

  // 멘티의 onChain.mentorAddress 는 mentors 컬렉션에 등록된 개인지갑 주소로 저장됨.
  // 수탁 지갑 주소(wallet.address)와 다를 수 있으므로 mentors 컬렉션도 확인.
  let queryAddress = myAddress;
  const email = userData?.email;
  if (email) {
    const mentorSnap = await db.collection('mentors').doc(email.toLowerCase()).get();
    if (mentorSnap.exists) {
      queryAddress = mentorSnap.data()?.address || myAddress;
    }
  }

  if (!queryAddress) return { mentees: [], myAddress: null };

  // 대소문자 불일치 대비: 체크섬 주소와 소문자 주소 모두 조회 후 합산
  const checksumAddr = ethers.getAddress(queryAddress);
  const lowerAddr    = queryAddress.toLowerCase();

  const [snapChecksum, snapLower] = await Promise.all([
    db.collection('users').where('onChain.mentorAddress', '==', checksumAddr).get(),
    checksumAddr !== lowerAddr
      ? db.collection('users').where('onChain.mentorAddress', '==', lowerAddr).get()
      : Promise.resolve({ docs: [] }),
  ]);

  // 중복 제거 (uid 기준)
  const seen = new Set();
  const allDocs = [...snapChecksum.docs, ...snapLower.docs].filter((d) => {
    if (seen.has(d.id)) return false;
    seen.add(d.id);
    return true;
  });

  const mentees = allDocs.map((d) => {
    const data = d.data();
    return {
      uid:          d.id,
      name:         data.name || '-',
      address:      data.wallet?.address || null,
      registeredAt: data.onChain?.registeredAt?.toMillis?.() ?? null,
    };
  });

  return { mentees, myAddress };
}

// ────────────────────────────────────────────────
// 관리자 셀프 온보딩
// ────────────────────────────────────────────────

/**
 * adminSelfOnboard
 * 관리자 계정(daguri75 등)을 ADMIN_PRIVATE_KEY 지갑 주소로 연결
 * - 온체인 미등록이면 register(ZeroAddress) 호출
 * - Firestore에 wallet.address + wallet.type='admin' 저장
 *
 * @param {string} uid - 관리자 Firebase UID
 * @returns {{ address, level, txHash }}
 */
async function adminSelfOnboard(uid) {
  const adminWallet   = getAdminWallet();
  const address       = adminWallet.address;
  const provider      = getProvider();
  const platformView  = getPlatformContract(provider);

  // 온체인 등록 여부 확인
  const [level] = await platformView.members(address);

  let txHash = null;
  if (Number(level) === 0) {
    // 미등록이면 관리자 키로 직접 register()
    const platformSigned = getPlatformContract(adminWallet);
    const gasLimit = await estimateGasWithBuffer(platformSigned, 'register', [ethers.ZeroAddress]);
    const tx = await platformSigned.register(ethers.ZeroAddress, { gasLimit });
    const receipt = await tx.wait();
    txHash = receipt.hash;
  }

  // Firestore 업데이트: wallet.type='admin' 으로 표시
  await db.collection('users').doc(uid).set({
    wallet: {
      address,
      type: 'admin',
    },
    onChain: {
      registered:    true,
      registeredAt:  admin.firestore.FieldValue.serverTimestamp(),
      mentorAddress: ethers.ZeroAddress,
      txHash:        txHash || 'already-registered',
      autoRegistered: true,
    },
  }, { merge: true });

  return { address, level: Number(level) || 1, txHash };
}

module.exports = {
  createCustodialWallet,
  registerOnChain,
  registerMentor,
  getUserOnChainData,
  getMyMentees,
  adminSelfOnboard,
};
