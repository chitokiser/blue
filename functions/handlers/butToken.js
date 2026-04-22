// functions/handlers/butToken.js
// BUT 토큰 매수/매도/스테이킹/출금/배당청구 — 수탁 지갑(Google 계정) 전용

'use strict';

const admin  = require('firebase-admin');
const { ethers } = require('ethers');
const { decrypt } = require('../wallet/crypto');
const {
  ADDRESSES,
  getProvider,
  getButTokenContract,
  getHexTokenContract,
  getButBankContract,
  walletFromKey,
  estimateGasWithBuffer,
} = require('../wallet/chain');

function db() { return admin.firestore(); }

// act 비트마스크 상수 (butBank.sol 기준)
const ACT_BUY   = 1;
const ACT_SELL  = 2;
const ACT_STAKE = 4;
const ACT_WD    = 8;
const ACT_DIV   = 16;

// ─────────────────────────────────────────────
// 헬퍼: 수탁 지갑 signer 준비 (linkedFrom 지원)
// ─────────────────────────────────────────────
async function getCustodialSigner(uid, masterSecret) {
  const snap = await db().collection('users').doc(uid).get();
  const data = snap.data();
  if (!data) throw new Error('사용자를 찾을 수 없습니다.');

  let walletData = data.wallet;

  // 연결된 지갑인 경우 소스 UID에서 키 로드
  if (walletData?.linkedFrom) {
    const sourceSnap = await db().collection('users').doc(walletData.linkedFrom).get();
    const sourceData = sourceSnap.data();
    if (!sourceData?.wallet?.encryptedKey) {
      throw new Error('연결된 지갑의 키를 찾을 수 없습니다.');
    }
    walletData = { ...walletData, encryptedKey: sourceData.wallet.encryptedKey };
  }

  if (!walletData?.encryptedKey) {
    throw new Error('수탁 지갑이 없습니다. 먼저 회원가입을 완료해주세요.');
  }

  const privateKey = decrypt(walletData.encryptedKey, masterSecret);
  const provider   = getProvider();
  const signer     = walletFromKey(privateKey, provider);
  return { signer, address: walletData.address };
}

// ─────────────────────────────────────────────
// 1. butBank 현황 조회 (read-only, 지갑 불필요)
// ─────────────────────────────────────────────
async function getButStatus(uid) {
  const provider  = getProvider();
  const bank      = getButBankContract(provider);
  const butToken  = getButTokenContract(provider);
  const hexToken  = getHexTokenContract(provider);

  // 사용자 지갑 주소 조회
  const snap = await db().collection('users').doc(uid).get();
  const walletData = snap.data()?.wallet;
  const userAddress = walletData?.address ?? null;

  // 글로벌 상태 병렬 조회
  const [
    price,
    totalStaked,
    hexBal,
    effectiveStaked,
    tokenInventory,
    circulatingSupply,
    act,
    autoStakeBps,
  ] = await Promise.all([
    bank.price(),
    bank.totalStaked(),
    bank.hexBalance(),
    bank.effectiveStaked(),
    bank.tokenInventory(),
    bank.circulatingSupply(),
    bank.act(),
    bank.autoStakeBps(),
  ]);

  let userInfo = null;
  if (userAddress) {
    const [userStruct, pendingDiv, dashboard, butBal, hexBal2] = await Promise.all([
      bank.user(userAddress),
      bank.pendingDividend(userAddress),
      bank.myDashboard(userAddress),
      butToken.balanceOf(userAddress),
      hexToken.balanceOf(userAddress),
    ]);

    userInfo = {
      address:      userAddress,
      totalAllow:   userStruct.totalAllow.toString(),
      totalBuy:     userStruct.totalBuy.toString(),
      depo:         userStruct.depo.toString(),
      stakingTime:  Number(userStruct.stakingTime),
      lastClaim:    Number(userStruct.lastClaim),
      pendingDiv:   pendingDiv.toString(),
      myActualQty:  dashboard.myActualQty.toString(),
      myPriceWei:   dashboard.currentPriceWei.toString(),
      myMarketCap:  dashboard.myMarketCapWei.toString(),
      myAvgBuy:     dashboard.myAvgBuyPriceWei.toString(),
      myPnlWei:     dashboard.myPnlWei.toString(),
      myRoiBps:     dashboard.myRoiBps_.toString(),
      butBalance:   butBal.toString(),
      hexBalance:   hexBal2.toString(),
    };
  }

  return {
    price:          price.toString(),
    totalStaked:    totalStaked.toString(),
    hexBalance:     hexBal.toString(),
    effectiveStaked: effectiveStaked.toString(),
    tokenInventory: tokenInventory.toString(),
    circulatingSupply: circulatingSupply.toString(),
    act:            Number(act),
    autoStakeBps:   Number(autoStakeBps),
    actFlags: {
      canBuy:   (Number(act) & ACT_BUY)   !== 0,
      canSell:  (Number(act) & ACT_SELL)  !== 0,
      canStake: (Number(act) & ACT_STAKE) !== 0,
      canWd:    (Number(act) & ACT_WD)    !== 0,
      canDiv:   (Number(act) & ACT_DIV)   !== 0,
    },
    user: userInfo,
  };
}

// ─────────────────────────────────────────────
// 2. BUT 매수 (HEX 승인 + buy)
// ─────────────────────────────────────────────
async function buyBut(uid, amount, masterSecret) {
  if (!Number.isInteger(amount) || amount < 1) {
    throw new Error('amount는 1 이상의 정수여야 합니다.');
  }

  const { signer } = await getCustodialSigner(uid, masterSecret);
  const provider   = getProvider();
  const bank       = getButBankContract(provider);
  const hexToken   = getHexTokenContract(signer);

  // 현재 가격 조회 → maxPay 계산 (5% 슬리피지)
  const priceWei   = await bank.price();
  const amountBn   = BigInt(amount);
  const costWei    = priceWei * amountBn;
  const maxPayWei  = (costWei * BigInt(105)) / BigInt(100);

  // HEX 잔액 확인
  const hexBal = await hexToken.balanceOf(signer.address);
  if (hexBal < costWei) {
    throw new Error(`HEX 잔액 부족 (필요: ${ethers.formatEther(costWei)}, 보유: ${ethers.formatEther(hexBal)})`);
  }

  // approve (필요시)
  const allowance = await hexToken.allowance(signer.address, ADDRESSES.butBank);
  if (allowance < maxPayWei) {
    const approveTx = await hexToken.approve(ADDRESSES.butBank, ethers.MaxUint256);
    await approveTx.wait();
  }

  // buy 실행
  const bankSigner = getButBankContract(signer);
  const gasLimit   = await estimateGasWithBuffer(bankSigner, 'buy', [amountBn, maxPayWei]);
  const tx         = await bankSigner.buy(amountBn, maxPayWei, { gasLimit });
  const receipt    = await tx.wait();

  return { txHash: receipt.hash, amount, costWei: costWei.toString() };
}

// ─────────────────────────────────────────────
// 3. BUT 매도
// ─────────────────────────────────────────────
async function sellBut(uid, amount, masterSecret) {
  if (!Number.isInteger(amount) || amount < 1) {
    throw new Error('amount는 1 이상의 정수여야 합니다.');
  }

  const { signer } = await getCustodialSigner(uid, masterSecret);
  const butToken   = getButTokenContract(signer);
  const bankSigner = getButBankContract(signer);

  const amountBn = BigInt(amount);

  // BUT 잔액 확인
  const butBal = await butToken.balanceOf(signer.address);
  if (butBal < amountBn) {
    throw new Error(`BUT 잔액 부족 (필요: ${amount}, 보유: ${butBal.toString()})`);
  }

  // butBank가 BUT 토큰을 인출할 수 있도록 approve
  const allowance = await butToken.allowance(signer.address, ADDRESSES.butBank);
  if (allowance < amountBn) {
    const approveTx = await butToken.approve(ADDRESSES.butBank, ethers.MaxUint256);
    await approveTx.wait();
  }

  const gasLimit = await estimateGasWithBuffer(bankSigner, 'sell', [amountBn]);
  const tx       = await bankSigner.sell(amountBn, { gasLimit });
  const receipt  = await tx.wait();

  return { txHash: receipt.hash, amount };
}

// ─────────────────────────────────────────────
// 4. BUT 스테이킹
// ─────────────────────────────────────────────
async function stakeBut(uid, amount, masterSecret) {
  if (!Number.isInteger(amount) || amount < 1) {
    throw new Error('amount는 1 이상의 정수여야 합니다.');
  }

  const { signer } = await getCustodialSigner(uid, masterSecret);
  const butToken   = getButTokenContract(signer);
  const bankSigner = getButBankContract(signer);

  const amountBn = BigInt(amount);

  const butBal = await butToken.balanceOf(signer.address);
  if (butBal < amountBn) {
    throw new Error(`BUT 잔액 부족 (필요: ${amount}, 보유: ${butBal.toString()})`);
  }

  // butBank가 BUT 토큰을 인출할 수 있도록 approve
  const allowance = await butToken.allowance(signer.address, ADDRESSES.butBank);
  if (allowance < amountBn) {
    const approveTx = await butToken.approve(ADDRESSES.butBank, ethers.MaxUint256);
    await approveTx.wait();
  }

  const gasLimit = await estimateGasWithBuffer(bankSigner, 'stake', [amountBn]);
  const tx       = await bankSigner.stake(amountBn, { gasLimit });
  const receipt  = await tx.wait();

  return { txHash: receipt.hash, amount };
}

// ─────────────────────────────────────────────
// 5. 스테이킹 출금 (락업 해제 후)
// ─────────────────────────────────────────────
async function withdrawBut(uid, masterSecret) {
  const { signer } = await getCustodialSigner(uid, masterSecret);
  const bankSigner = getButBankContract(signer);

  // 잠금 여부 확인
  const provider  = getProvider();
  const bank      = getButBankContract(provider);
  const userInfo  = await bank.user(signer.address);
  const LOCK_SECS = 120 * 24 * 3600; // 120일

  if (userInfo.depo === 0n) {
    throw new Error('스테이킹된 BUT이 없습니다.');
  }
  const now = Math.floor(Date.now() / 1000);
  const unlockAt = Number(userInfo.stakingTime) + LOCK_SECS;
  if (now < unlockAt) {
    const daysLeft = Math.ceil((unlockAt - now) / 86400);
    throw new Error(`락업 기간 중입니다. ${daysLeft}일 후 출금 가능합니다.`);
  }

  const gasLimit = await estimateGasWithBuffer(bankSigner, 'withdraw', []);
  const tx       = await bankSigner.withdraw({ gasLimit });
  const receipt  = await tx.wait();

  return { txHash: receipt.hash };
}

// ─────────────────────────────────────────────
// 6. 배당 청구
// ─────────────────────────────────────────────
async function claimButDividend(uid, masterSecret) {
  const { signer } = await getCustodialSigner(uid, masterSecret);
  const provider   = getProvider();
  const bank       = getButBankContract(provider);
  const bankSigner = getButBankContract(signer);

  const pending = await bank.pendingDividend(signer.address);
  if (pending === 0n) {
    throw new Error('청구 가능한 배당이 없습니다.');
  }

  const gasLimit = await estimateGasWithBuffer(bankSigner, 'claimDividend', []);
  const tx       = await bankSigner.claimDividend({ gasLimit });
  const receipt  = await tx.wait();

  return { txHash: receipt.hash, pendingWei: pending.toString() };
}

module.exports = {
  getButStatus,
  buyBut,
  sellBut,
  stakeBut,
  withdrawBut,
  claimButDividend,
};
