// functions/wallet/chain.js
// ethers.js v6 – opBNB RPC 연결 + butPlatform / BUT 컨트랙트 헬퍼

'use strict';

const { ethers } = require('ethers');

// ────────────────────────────────────────────────
// 체인 설정 (opBNB Mainnet)
// ────────────────────────────────────────────────
const RPC_URL = process.env.OPBNB_RPC || 'https://opbnb-mainnet-rpc.bnbchain.org';

const ADDRESSES = {
  butToken:    '0xc159663b769E6c421854E913460b973899B76E42',  // BUT 토큰 (0 decimals)
  hexToken:    '0x41F2Ea9F4eF7c4E35ba1a8438fC80937eD4E5464',  // HEX 결제 토큰 (18 decimals)
  butBank:     '0x7a310060BcE6e5C66d8eb47E19Ea50CefB963a33',  // butBank
  butTreasury: '0x47fac604B1E699E7fbE470598EF69024e8a43b7f',  // Treasury
  butPlatform: '0x93ded35508F56BA53C5653Eca736aDdfD994AFcd',  // 메인 플랫폼 컨트랙트
  jumpPlatform: '0x93ded35508F56BA53C5653Eca736aDdfD994AFcd',  // 레거시 alias
  coopMall:    '0x98C8CaA6020F24Cbf45a457a483aFAb59c317f1a',  // ButDaoCoopMall (CoopMall v3)
};

// ────────────────────────────────────────────────
// ABI — butPlatform (butPlatfrom.sol 기준)
// ────────────────────────────────────────────────
const PLATFORM_ABI = [
  // 가입
  'function register(address mentorAddr) external',

  // 관리자: KRW 오프체인 결제 후 HEX 지급
  'function adminCreditHex(address user, uint256 hexWei, bytes32 ref) external',

  // 조회: 멤버 정보
  'function members(address) external view returns (uint32 level, address mentor, uint256 exp, uint256 points, bool blocked)',

  // 조회: HEX 잔액 + 온체인 FX 환산 (display-only)
  'function getUserValueScaled(address user) external view returns (uint256 hexBalWei, uint256 krwValueScaled, uint256 usdValueScaled, uint256 vndValueScaled, uint32 scale)',

  // 조회: 레벨업 필요 EXP
  'function requiredExpForNextLevel(address user) external view returns (uint256)',

  // 조회: 공개 파라미터
  'function pointBaseDiv() external view returns (uint32)',
  'function mentorShareBps() external view returns (uint16)',
  'function jackpotShareBps() external view returns (uint16)',
  'function uplineReserveBps() external view returns (uint16)',
  'function taxThresholdWei() external view returns (uint256)',
  'function taxAccWei() external view returns (uint256)',
  'function jackpotAccWei() external view returns (uint256)',
  'function uplineReserveWei() external view returns (uint256)',
  'function fxKrwPerHexScaled() external view returns (uint256)',
  'function fxUsdPerHexScaled() external view returns (uint256)',
  'function fxVndPerHexScaled() external view returns (uint256)',
  'function fxScale() external view returns (uint32)',
  'function owner() external view returns (address)',
  'function pendingOwner() external view returns (address)',
  'function butBank() external view returns (address)',
  'function bootstrapMentor() external view returns (address)',
  'function nextMerchantId() external view returns (uint256)',

  // 조회: 준비금 현황
  'function solvencyReserve() external view returns (uint256 tax, uint256 jackpot, uint256 uplineReserve, uint256 reserved, uint256 contractBal, bool solvent)',

  // 유저 액션
  'function convertPointsToHex(uint256 pointsWei) external',
  'function mentorWithdrawPoints(uint256 pointsWei) external',
  'function requestLevelUp() external',
  'function payMerchantHex(uint256 merchantId, uint256 amountWei) external',
  'function registerMerchant(string calldata metadataURI) external returns (uint256 merchantId)',
  'function updateMerchantByOwner(uint256 merchantId, string calldata metadataURI, bool active) external',

  // 가맹점 조회
  'function merchants(uint256) external view returns (address ownerAddr, uint16 feeBps, bool active, string metadataURI, bool exists)',

  // 관리자 액션
  'function ownerDepositHex(uint256 amountWei) external',
  'function ownerWithdrawHex(address to, uint256 amountWei) external',
  'function manualFlushTax(uint256 maxAmountWei) external',
  'function setFx(uint256 krwPerHexScaled, uint256 usdPerHexScaled, uint256 vndPerHexScaled, uint32 scale) external',
  'function setParams(uint32 div_, uint16 mentorShareBps_, uint16 jackpotShareBps_, uint16 uplineReserveBps_, uint256 taxThresholdWei_) external',
  'function setbutBank(address jb, bool callHook) external',
  'function adminUpdateMerchantFee(uint256 merchantId, uint16 feeBps) external',
  'function adminUpdateMerchantOwner(uint256 merchantId, address newOwner) external',
  'function adminSetLevel(address user, uint32 level_) external',
  'function adminSetBlocked(address user, bool blocked_) external',
  'function adminChangeMentor(address user, address newMentor) external',
  'function transferOwnership(address newOwner) external',
  'function acceptOwnership() external',

  // 이벤트
  'event Registered(address indexed user, address indexed mentor)',
  'event AdminCreditHex(address indexed user, uint256 hexWei, bytes32 indexed ref)',
  'event MerchantRegistered(uint256 indexed merchantId, address indexed ownerAddr)',
  'event MerchantMetaUpdated(uint256 indexed merchantId, string metadataURI, bool active)',
  'event MerchantFeeUpdated(uint256 indexed merchantId, uint16 feeBps)',
  'event PaidHex(address indexed buyer, uint256 indexed merchantId, uint256 amountWei, uint256 feeWei, uint256 expGain)',
  'event JackpotPointsAwarded(address indexed user, uint256 pointsWei, uint256 rand)',
  'event PointsConverted(address indexed user, uint256 pointsWei, uint256 hexWei)',
  'event TaxFlush(address indexed to, uint256 amountWei, bool ok)',
  'event FxUpdated(uint256 krwPerHexScaled, uint256 usdPerHexScaled, uint256 vndPerHexScaled, uint32 fxScale)',
  'event OwnershipTransferStarted(address indexed from, address indexed to)',
  'event OwnershipTransferred(address indexed from, address indexed to)',
];

// BUT 토큰 ABI (ERC20, 0 decimals)
const BUT_TOKEN_ABI = [
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function allowance(address owner, address spender) external view returns (uint256)',
  'function balanceOf(address account) external view returns (uint256)',
  'function transfer(address to, uint256 amount) external returns (bool)',
  'function totalSupply() external view returns (uint256)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event Approval(address indexed owner, address indexed spender, uint256 value)',
];

// HEX 결제 토큰 ABI (ERC20, 18 decimals) — butBank의 결제 수단
const HEX_TOKEN_ABI = [
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function allowance(address owner, address spender) external view returns (uint256)',
  'function balanceOf(address account) external view returns (uint256)',
  'function transfer(address to, uint256 amount) external returns (bool)',
  'function decimals() external view returns (uint8)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event Approval(address indexed owner, address indexed spender, uint256 value)',
];

// ────────────────────────────────────────────────
// BUT bank ABI (butBank.sol) — 전체 ABI
// ────────────────────────────────────────────────
const BUT_BANK_ABI = [
  // 조회 — 글로벌
  'function price() external view returns (uint256)',
  'function totalStaked() external view returns (uint256)',
  'function hexBalance() external view returns (uint256)',
  'function effectiveStaked() external view returns (uint256)',
  'function tokenInventory() external view returns (uint256)',
  'function circulatingSupply() external view returns (uint256)',
  'function totalfee() external view returns (uint256)',
  'function rate() external view returns (uint8)',
  'function act() external view returns (uint8)',
  'function autoStakeBps() external view returns (uint16)',

  // 조회 — 사용자별
  'function user(address who) external view returns (uint256 totalAllow, uint256 totalBuy, uint256 depo, uint256 stakingTime, uint256 lastClaim)',
  'function pendingDividend(address who) external view returns (uint256)',
  'function myDashboard(address who) external view returns (uint256 myActualQty, uint256 currentPriceWei, uint256 myMarketCapWei, uint256 myAvgBuyPriceWei, int256 myPnlWei, int256 myRoiBps_)',

  // 쓰기 — 사용자 액션
  'function buy(uint256 amount, uint256 maxPay) external returns (bool)',
  'function sell(uint256 amount) external returns (bool)',
  'function stake(uint256 amount) external returns (bool)',
  'function withdraw() external returns (bool)',
  'function claimDividend() external returns (bool)',
];

// ────────────────────────────────────────────────
// CoopMall ABI (ButDaoCoopMall.sol)
// ────────────────────────────────────────────────
const COOP_MALL_ABI = [
  // 조회
  'function users(address) external view returns (bool eligible, bool member, address mentor, uint256 points)',
  'function membershipFeeHex() external view returns (uint256)',
  'function voucherTemplateCount() external view returns (uint256)',
  'function voucherCount() external view returns (uint256)',
  'function voucherTemplates(uint256) external view returns (uint256 hexPrice, uint16 burnFeeBps, bool active, string description, string usagePlace, string imageURI)',
  'function vouchers(uint256) external view returns (uint256 templateId, address owner, bool burned)',
  'function owner() external view returns (address)',

  // 회원 액션
  'function joinMall() external',

  // 바우처 액션
  'function buyVoucher(uint256 templateId) external',
  'function transferVoucher(uint256 voucherId, address to) external',
  'function burnVoucher(uint256 voucherId) external',

  // 관리자 액션
  'function grantEligibility(address user, address mentor) external',
  'function createVoucherTemplate(uint256 hexPrice, uint16 burnFeeBps, string calldata description, string calldata usagePlace, string calldata imageURI) external returns (uint256)',
  'function updateVoucherTemplate(uint256 templateId, uint256 hexPrice, uint16 burnFeeBps, bool active, string calldata description, string calldata usagePlace, string calldata imageURI) external',
  'function setMembershipFee(uint256 newFeeWei) external',
  'function setMentorRewardBps(uint16 bps) external',
  'function withdrawHex(address to, uint256 amount) external',
  'function withdrawbut(address to, uint256 amount) external',

  // 이벤트
  'event EligibilityGranted(address indexed user, address indexed mentor)',
  'event MemberJoined(address indexed user, uint256 feeHex, uint256 butGiven)',
  'event VoucherTemplateCreated(uint256 indexed templateId, uint256 hexPrice, uint16 burnFeeBps)',
  'event VoucherBought(uint256 indexed voucherId, uint256 indexed templateId, address indexed buyer)',
  'event VoucherTransferred(uint256 indexed voucherId, address indexed from, address indexed to)',
  'event VoucherBurned(uint256 indexed voucherId, address indexed owner, uint256 hexReturned, uint256 feeKept)',
];

// ────────────────────────────────────────────────
// 팩토리 함수
// ────────────────────────────────────────────────

function getProvider() {
  return new ethers.JsonRpcProvider(RPC_URL);
}

function getPlatformContract(signerOrProvider) {
  return new ethers.Contract(ADDRESSES.butPlatform, PLATFORM_ABI, signerOrProvider);
}

function getButTokenContract(signerOrProvider) {
  return new ethers.Contract(ADDRESSES.butToken, BUT_TOKEN_ABI, signerOrProvider);
}

function getButBankContract(signerOrProvider) {
  return new ethers.Contract(ADDRESSES.butBank, BUT_BANK_ABI, signerOrProvider);
}

function getHexTokenContract(signerOrProvider) {
  return new ethers.Contract(ADDRESSES.hexToken, HEX_TOKEN_ABI, signerOrProvider);
}

// 하위 호환: 기존 코드에서 getHexContract() 호출 시 butToken 반환
function getHexContract(signerOrProvider) {
  return getButTokenContract(signerOrProvider);
}

// 하위 호환: 기존 jumpBank 호출은 butBank로 매핑
function getJumpBankContract(signerOrProvider) {
  return getButBankContract(signerOrProvider);
}

// 하위 호환: 기존 JumpToken 호출은 ButToken으로 매핑
function getJumpTokenContract(signerOrProvider) {
  return getButTokenContract(signerOrProvider);
}

function getCoopMallContract(signerOrProvider) {
  return new ethers.Contract(ADDRESSES.coopMall, COOP_MALL_ABI, signerOrProvider);
}

/**
 * 복호화된 private key로 Wallet 복원
 */
function walletFromKey(privateKey, provider) {
  return new ethers.Wallet(privateKey, provider ?? getProvider());
}

/**
 * 관리자 지갑 (butPlatform.owner – adminCreditHex 호출 권한)
 * ADMIN_PRIVATE_KEY = Firebase Secret Manager에서 주입
 */
function getAdminWallet() {
  const key = process.env.ADMIN_PRIVATE_KEY;
  if (!key) throw new Error('[chain] ADMIN_PRIVATE_KEY Secret이 설정되지 않았습니다');
  return new ethers.Wallet(key, getProvider());
}

/**
 * 가스 추정 후 10% 여유분 추가
 */
async function estimateGasWithBuffer(contract, method, args) {
  const estimated = await contract[method].estimateGas(...args);
  return (estimated * BigInt(110)) / BigInt(100);
}

module.exports = {
  ADDRESSES,
  getProvider,
  getPlatformContract,
  getButTokenContract,
  getHexTokenContract,
  getButBankContract,
  getCoopMallContract,
  getHexContract,        // 하위 호환 alias
  walletFromKey,
  getAdminWallet,
  estimateGasWithBuffer,
};
