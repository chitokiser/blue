// /contracts/butPlatform.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/*
 * butPlatform — HEX 기반 가맹점 결제 + 멘토 포인트 + 잭팟 복권
 *
 * 수수료 배분 (가맹점 feeBps 기준):
 *   - 30% → 멘토 포인트 (mentorShareBps)
 *   - 30% → 잭팟 누적 (jackpotShareBps)
 *   - 10% → 세금/플랫폼 (taxShareBps, butBank 100 HEX 도달 시 자동 이체)
 *   - 30% → 멘토의 멘토 예치금 (uplineReserveBps, 상위 포인트 지급 담보)
 *
 * 잭팟 복권:
 *   결제마다 (수수료 + jackpotAccWei) / rand(100~1,000,000) 포인트를 구매자에게 지급.
 *   복권 포인트는 jackpotAccWei에서 차감되어 과지급 불가.
 *
 * 포인트 전환:
 *   - 일반(convertPointsToHex): points * level / pointBaseDiv → HEX, 50%를 멘토에게 포인트 적립
 *   - 멘토 전용(mentorWithdrawPoints, level≥2): 1:1 HEX 전환, 전환액의 50%를 멘토의 멘토(2단계 상위)에게 포인트 적립
 *
 * ⚠ 랜덤 보안: blockhash 기반 의사난수. 검증자 조작 가능성 존재.
 *   고액 운영 시 Chainlink VRF v2(BSC 지원)로 교체 권장.
 */

interface IERC20 {
  function transfer(address to, uint256 amount) external returns (bool);
  function transferFrom(address from, address to, uint256 amount) external returns (bool);
  function balanceOf(address account) external view returns (uint256);
}

interface IbutBank {
  function onTaxReceived(uint256 amount) external;
}

contract butPlatfrom {
  IERC20 public immutable HEX;

  // ---------- custom errors ----------
  error OnlyOwner();
  error OnlyPendingOwner();
  error MemberRequired();
  error MemberBlocked();
  error AlreadyMember();
  error MentorRequired();
  error NotMember();
  error ZeroAddr();
  error ZeroAmount();
  error RefUsed();
  error TransferFail();
  error MerchantMissing();
  error MerchantInactive();
  error NotMerchantOwner();
  error FeeTooHigh();
  error InsufficientPoints();
  error InsufficientHex();
  error NeedExp();
  error MentorLevelRequired();
  error butBankZero();
  error InsufficientReserve(); // ownerWithdraw가 준비금을 침범할 때

  // ---------- constants ----------
  uint16 public constant BPS_DENOM = 10000;
  uint16 public constant MAX_FEE_BPS = 3000; // 가맹점 최대 수수료 30%

  // ---------- admin params ----------
  address public owner;
  address public pendingOwner; // 2단계 소유권 이전용

  address public bootstrapMentor;

  uint32 public pointBaseDiv = 10;          // 일반 전환: points * level / div
  uint16 public mentorShareBps     = 3000;  // 수수료의 30% → 멘토 포인트
  uint16 public jackpotShareBps    = 3000;  // 수수료의 30% → 잭팟
  uint16 public uplineReserveBps   = 3000;  // 수수료의 30% → 멘토의 멘토 예치금
  // 세금 = fee - mentor - jackpot - uplineReserve = 10% (taxShareBps 파생, 별도 변수 없음)
  uint256 public taxThresholdWei = 100e18;  // 100 HEX (18 decimals 기준)

  address public butBank;       // 배포 시 생성자에서 설정
  bool public callbutBankHook;

  // ---------- FX (표시 전용) ----------
  uint256 public fxKrwPerHexScaled;
  uint256 public fxUsdPerHexScaled;
  uint256 public fxVndPerHexScaled;
  uint32  public fxScale = 100;

  // ---------- structs ----------
  struct Member {
    uint32  level;   // 0 = 미가입
    address mentor;
    uint256 exp;
    uint256 points;  // wei 단위 포인트
    bool    blocked;
  }

  struct Merchant {
    address ownerAddr;
    uint16  feeBps;
    bool    active;
    string  metadataURI;
    bool    exists;
  }

  // ---------- state ----------
  mapping(address => Member)   public members;
  mapping(uint256 => Merchant) public merchants;
  uint256 public nextMerchantId = 1;

  mapping(bytes32 => bool)    public usedTopupRef;
  mapping(address => uint256) private _nonce; // 유저별 랜덤 nonce

  uint256 public taxAccWei;
  uint256 public jackpotAccWei;      // 잭팟 누적 풀 (복권 지급 시 차감)
  uint256 public uplineReserveWei;   // 멘토의 멘토 포인트 지급 담보금 (인출 불가)

  // ---------- events ----------
  event Registered(address indexed user, address indexed mentor);
  event AdminCreditHex(address indexed user, uint256 hexWei, bytes32 indexed ref);
  event MerchantRegistered(uint256 indexed merchantId, address indexed ownerAddr);
  event MerchantMetaUpdated(uint256 indexed merchantId, string metadataURI, bool active);
  event MerchantFeeUpdated(uint256 indexed merchantId, uint16 feeBps);
  event MerchantOwnerUpdated(uint256 indexed merchantId, address indexed ownerAddr);
  event PaidHex(address indexed buyer, uint256 indexed merchantId, uint256 amountWei, uint256 feeWei, uint256 expGain);
  event JackpotPointsAwarded(address indexed user, uint256 pointsWei, uint256 rand);
  event PointsConverted(address indexed user, uint256 pointsWei, uint256 hexWei);
  event TaxFlush(address indexed to, uint256 amountWei, bool ok);
  event FxUpdated(uint256 krwPerHexScaled, uint256 usdPerHexScaled, uint256 vndPerHexScaled, uint32 fxScale);
  event OwnershipTransferStarted(address indexed from, address indexed to);
  event OwnershipTransferred(address indexed from, address indexed to);

  // ---------- modifiers ----------
  modifier onlyOwner() {
    if (msg.sender != owner) revert OnlyOwner();
    _;
  }

  modifier onlyMember() {
    Member storage m = members[msg.sender];
    if (m.level == 0) revert MemberRequired();
    if (m.blocked)    revert MemberBlocked();
    _;
  }

  modifier memberExists(address user) {
    if (user == address(0))        revert ZeroAddr();
    if (members[user].level == 0)  revert NotMember();
    _;
  }

  // ---------- constructor ----------
  constructor(address hexToken, address _bootstrapMentor, address _butBank) {
    if (hexToken == address(0)) revert ZeroAddr();
    HEX   = IERC20(hexToken);
    owner = msg.sender;

    // butBank은 address(0) 허용 (나중에 setbutBank으로 변경 가능)
    butBank = _butBank;

    bootstrapMentor = _bootstrapMentor;
    if (_bootstrapMentor != address(0)) {
      members[_bootstrapMentor] = Member({
        level:   1,
        mentor:  address(0),
        exp:     0,
        points:  0,
        blocked: false
      });
      emit Registered(_bootstrapMentor, address(0));
    }
  }

  // ==========================================================================
  // OWNERSHIP — 2단계 이전 (키 분실/탈취 대응)
  // ==========================================================================

  /// @notice 새 owner 후보를 지정. 후보가 acceptOwnership을 호출해야 완료.
  function transferOwnership(address newOwner) external onlyOwner {
    if (newOwner == address(0)) revert ZeroAddr();
    pendingOwner = newOwner;
    emit OwnershipTransferStarted(owner, newOwner);
  }

  /// @notice pendingOwner만 호출 가능. 소유권 최종 이전.
  function acceptOwnership() external {
    if (msg.sender != pendingOwner) revert OnlyPendingOwner();
    emit OwnershipTransferred(owner, msg.sender);
    owner        = msg.sender;
    pendingOwner = address(0);
  }

  // ==========================================================================
  // ADMIN
  // ==========================================================================

  /// @notice mentor + jackpot + uplineReserve 합 ≤ 10000 필수 (나머지가 tax, 0 이상이어야 함)
  function setParams(
    uint32  div_,
    uint16  mentorShareBps_,
    uint16  jackpotShareBps_,
    uint16  uplineReserveBps_,
    uint256 taxThresholdWei_
  ) external onlyOwner {
    if (div_ == 0)             revert ZeroAmount();
    if (taxThresholdWei_ == 0) revert ZeroAmount();
    if (uint32(mentorShareBps_) + uint32(jackpotShareBps_) + uint32(uplineReserveBps_) > uint32(BPS_DENOM))
      revert FeeTooHigh();
    pointBaseDiv      = div_;
    mentorShareBps    = mentorShareBps_;
    jackpotShareBps   = jackpotShareBps_;
    uplineReserveBps  = uplineReserveBps_;
    taxThresholdWei   = taxThresholdWei_;
  }

  function setBootstrapMentor(address m) external onlyOwner {
    bootstrapMentor = m;
  }

  function setbutBank(address jb, bool callHook) external onlyOwner {
    butBank         = jb;
    callbutBankHook = callHook;
  }

  function setFx(
    uint256 krwPerHexScaled,
    uint256 usdPerHexScaled,
    uint256 vndPerHexScaled,
    uint32  scale
  ) external onlyOwner {
    if (scale == 0) revert ZeroAmount();
    fxKrwPerHexScaled = krwPerHexScaled;
    fxUsdPerHexScaled = usdPerHexScaled;
    fxVndPerHexScaled = vndPerHexScaled;
    fxScale           = scale;
    emit FxUpdated(krwPerHexScaled, usdPerHexScaled, vndPerHexScaled, scale);
  }

  function adminSetBlocked(address user, bool blocked_) external onlyOwner memberExists(user) {
    members[user].blocked = blocked_;
  }

  function adminSetLevel(address user, uint32 level_) external onlyOwner memberExists(user) {
    if (level_ == 0) revert ZeroAmount();
    members[user].level = level_;
  }

  function adminChangeMentor(address user, address newMentor) external onlyOwner memberExists(user) {
    if (newMentor == address(0)) revert ZeroAddr();
    members[user].mentor = newMentor;
  }

  // ==========================================================================
  // OWNER HEX FUNDING
  // ==========================================================================

  function ownerDepositHex(uint256 amountWei) external onlyOwner {
    if (amountWei == 0) revert ZeroAmount();
    if (!HEX.transferFrom(msg.sender, address(this), amountWei)) revert TransferFail();
  }

  /// @notice taxAccWei + jackpotAccWei + uplineReserveWei 준비금을 침범하는 인출 불가.
  ///         세금 버퍼 + 복권 풀 + 멘토의 멘토 예치금 모두 보호.
  function ownerWithdrawHex(address to, uint256 amountWei) external onlyOwner {
    if (to == address(0)) revert ZeroAddr();
    if (amountWei == 0)   revert ZeroAmount();
    uint256 reserved = taxAccWei + jackpotAccWei + uplineReserveWei;
    uint256 bal      = HEX.balanceOf(address(this));
    if (bal < reserved + amountWei) revert InsufficientReserve();
    if (!HEX.transfer(to, amountWei)) revert TransferFail();
  }

  // ==========================================================================
  // MEMBER
  // ==========================================================================

  function register(address mentorAddr) external {
    if (members[msg.sender].level != 0) revert AlreadyMember();

    address m = mentorAddr;
    if (m == address(0)) m = bootstrapMentor;
    if (m == address(0)) revert MentorRequired();

    members[msg.sender] = Member({
      level:   1,
      mentor:  m,
      exp:     0,
      points:  0,
      blocked: false
    });
    emit Registered(msg.sender, m);
  }

  function requiredExpForNextLevel(address user) public view memberExists(user) returns (uint256) {
    uint256 lv = members[user].level;
    return (lv * lv) * 10000;
  }

  function requestLevelUp() external onlyMember {
    Member storage u = members[msg.sender];
    uint256 need = (uint256(u.level) * uint256(u.level)) * 10000;
    if (u.exp < need) revert NeedExp();
    unchecked {
      u.exp   -= need;
      u.level += 1;
    }
  }

  // ==========================================================================
  // ADMIN CREDIT (KRW 오프체인 결제 → HEX 지급)
  // ==========================================================================

  function adminCreditHex(address user, uint256 hexWei, bytes32 ref)
    external onlyOwner memberExists(user)
  {
    if (hexWei == 0)              revert ZeroAmount();
    if (usedTopupRef[ref])        revert RefUsed();
    usedTopupRef[ref] = true;
    if (!HEX.transfer(user, hexWei)) revert TransferFail();
    emit AdminCreditHex(user, hexWei, ref);
  }

  // ==========================================================================
  // MERCHANT
  // ==========================================================================

  function registerMerchant(string calldata metadataURI)
    external onlyMember returns (uint256 merchantId)
  {
    merchantId = nextMerchantId++;
    merchants[merchantId] = Merchant({
      ownerAddr:   msg.sender,
      feeBps:      0,
      active:      true,
      metadataURI: metadataURI,
      exists:      true
    });
    emit MerchantRegistered(merchantId, msg.sender);
  }

  function updateMerchantByOwner(uint256 merchantId, string calldata metadataURI, bool active) external {
    Merchant storage m = merchants[merchantId];
    if (!m.exists)               revert MerchantMissing();
    if (msg.sender != m.ownerAddr) revert NotMerchantOwner();
    m.metadataURI = metadataURI;
    m.active      = active;
    emit MerchantMetaUpdated(merchantId, metadataURI, active);
  }

  function adminUpdateMerchantFee(uint256 merchantId, uint16 feeBps) external onlyOwner {
    Merchant storage m = merchants[merchantId];
    if (!m.exists)         revert MerchantMissing();
    if (feeBps > MAX_FEE_BPS) revert FeeTooHigh();
    m.feeBps = feeBps;
    emit MerchantFeeUpdated(merchantId, feeBps);
  }

  function adminUpdateMerchantOwner(uint256 merchantId, address newOwner) external onlyOwner {
    Merchant storage m = merchants[merchantId];
    if (!m.exists)           revert MerchantMissing();
    if (newOwner == address(0)) revert ZeroAddr();
    m.ownerAddr = newOwner;
    emit MerchantOwnerUpdated(merchantId, newOwner);
  }

  // ==========================================================================
  // PAYMENT
  // 수수료 4분할: 30% 멘토 포인트 / 30% 잭팟 / 10% 세금 / 30% 멘토의 멘토 예치금
  // 복권:   (수수료 + jackpotAccWei) / rand(100~1,000,000) → 구매자 포인트
  //         jackpotAccWei 초과 지급 불가, 지급 시 jackpotAccWei 차감
  // CEI 패턴 준수: 모든 상태 변경 → 외부 호출 순서
  // ==========================================================================

  function payMerchantHex(uint256 merchantId, uint256 amountWei) external onlyMember {
    Merchant storage mer = merchants[merchantId];
    if (!mer.exists)    revert MerchantMissing();
    if (!mer.active)    revert MerchantInactive();
    if (amountWei == 0) revert ZeroAmount();

    // [1] 유저 HEX 수령
    if (!HEX.transferFrom(msg.sender, address(this), amountWei)) revert TransferFail();

    uint256 fee = (amountWei * mer.feeBps) / BPS_DENOM;
    uint256 net = amountWei - fee;

    uint256 expGain;
    if (fee != 0) {
      address mentor = members[msg.sender].mentor;
      if (mentor == address(0)) mentor = bootstrapMentor;

      uint256 mentorPts      = (fee * mentorShareBps)    / BPS_DENOM; // 30%
      uint256 jackpotShare   = (fee * jackpotShareBps)   / BPS_DENOM; // 30%
      uint256 uplineReserve  = (fee * uplineReserveBps)  / BPS_DENOM; // 30%
      uint256 tax            = fee - mentorPts - jackpotShare - uplineReserve; // 10%

      // [2] 상태 변경 (CEI: 외부 호출 전 완료)
      if (mentor != address(0) && mentorPts != 0) {
        members[mentor].points += mentorPts;
      }
      if (jackpotShare != 0) {
        jackpotAccWei += jackpotShare;
      }
      if (uplineReserve != 0) {
        uplineReserveWei += uplineReserve; // 멘토의 멘토 포인트 지급 담보 적립
      }
      if (tax != 0) {
        taxAccWei += tax;
      }

      expGain = fee / 1e16;
      if (expGain != 0) members[msg.sender].exp += expGain;

      // [3] 잭팟 복권 — jackpotAccWei 범위 내에서만 지급
      uint256 rand = _pseudoRand(msg.sender, merchantId, amountWei);
      uint256 lotteryPts = (fee + jackpotAccWei) / rand;
      if (lotteryPts > jackpotAccWei) lotteryPts = jackpotAccWei; // 과지급 방지
      if (lotteryPts != 0) {
        jackpotAccWei              -= lotteryPts; // jackpot 차감
        members[msg.sender].points += lotteryPts;
        emit JackpotPointsAwarded(msg.sender, lotteryPts, rand);
      }
    }

    // [4] 외부 호출: 가맹점 정산
    if (!HEX.transfer(mer.ownerAddr, net)) revert TransferFail();
    emit PaidHex(msg.sender, merchantId, amountWei, fee, expGain);

    // [5] 세금 플러시 (임계치 도달 시)
    _tryFlushTax();
  }

  // ==========================================================================
  // PSEUDO-RANDOMNESS
  // blockhash(block.number - 1): BSC에서 prevrandao보다 안정적
  // 유저별 nonce: 동일 블록 내 여러 결제 시 예측 불가
  // ⚠ 검증자가 블록을 선택적으로 포함/제외해 유리한 결과를 만들 수 있음.
  //   고액 잭팟 운영 시 Chainlink VRF v2 교체 강력 권장.
  // ==========================================================================

  function _pseudoRand(address user, uint256 merchantId, uint256 amount)
    internal returns (uint256)
  {
    uint256 nonce = _nonce[user]++;
    return (uint256(keccak256(abi.encodePacked(
      blockhash(block.number - 1), // 이전 블록 해시 (256블록 이내 유효)
      block.timestamp,
      user,
      merchantId,
      amount,
      nonce
    ))) % 999901) + 100; // [100, 1_000_000]
  }

  // ==========================================================================
  // POINTS CONVERSION
  // ==========================================================================

  /// @notice 일반 전환: points * level / pointBaseDiv → HEX, 50%를 상위 멘토에게 포인트 적립
  function convertPointsToHex(uint256 pointsWei) external onlyMember {
    _convertPoints(msg.sender, pointsWei);
  }

  /// @notice 멘토 전용(level≥2): 포인트 100% 1:1 HEX 전환.
  ///         전환한 HEX의 50%를 멘토의 멘토(2단계 상위)에게 포인트로 적립.
  ///         순환 체인 및 동일 주소 중복 적립 방지.
  function mentorWithdrawPoints(uint256 pointsWei) external onlyMember {
    if (members[msg.sender].level < 2) revert MentorLevelRequired();
    if (pointsWei == 0) revert ZeroAmount();

    Member storage u = members[msg.sender];
    if (u.points < pointsWei) revert InsufficientPoints();

    // CEI: 상태 먼저
    u.points -= pointsWei;

    // 1:1 HEX 전환 (포인트 100% → HEX)
    uint256 hexOut = pointsWei;
    if (HEX.balanceOf(address(this)) < hexOut) revert InsufficientHex();
    if (!HEX.transfer(msg.sender, hexOut)) revert TransferFail();
    emit PointsConverted(msg.sender, pointsWei, hexOut);

    // 전환 HEX의 50%를 멘토의 멘토(2단계 상위)에게 포인트로 적립
    address upline1 = u.mentor;
    if (upline1 == address(0)) upline1 = bootstrapMentor;

    address upline2 = (upline1 != address(0)) ? members[upline1].mentor : address(0);
    if (upline2 == address(0)) upline2 = bootstrapMentor;

    uint256 uplinePts = hexOut / 2; // 전환 HEX의 50%
    if (
      upline2 != address(0) &&
      upline2 != msg.sender && // 자기 자신 방지
      upline2 != upline1  &&   // 동일 주소 중복 방지
      uplinePts != 0
    ) {
      members[upline2].points += uplinePts;
      // 예치금에서 지급분 차감 (언더플로 방지)
      if (uplineReserveWei >= uplinePts) {
        uplineReserveWei -= uplinePts;
      } else {
        uplineReserveWei = 0;
      }
    }

    _tryFlushTax();
  }

  function _convertPoints(address user, uint256 pointsWei) internal {
    if (pointsWei == 0) revert ZeroAmount();

    Member storage u = members[user];
    if (u.points < pointsWei) revert InsufficientPoints();

    // CEI: 상태 먼저
    u.points -= pointsWei;

    uint256 hexOut = (pointsWei * uint256(u.level)) / uint256(pointBaseDiv);
    if (hexOut == 0) revert ZeroAmount();

    if (HEX.balanceOf(address(this)) < hexOut) revert InsufficientHex();
    if (!HEX.transfer(user, hexOut)) revert TransferFail();
    emit PointsConverted(user, pointsWei, hexOut);

    // 50%를 상위 멘토 포인트 적립 (순환 방지: target != user)
    address target = u.mentor;
    if (target == address(0)) target = bootstrapMentor;

    uint256 addPts = pointsWei / 2;
    if (target != address(0) && target != user && addPts != 0) {
      members[target].points += addPts;
    }

    _tryFlushTax();
  }

  // ==========================================================================
  // TAX FLUSH — DoS-safe: 임계치 도달 시만 시도, 실패해도 절대 revert 없음
  // ==========================================================================

  function _tryFlushTax() internal {
    if (taxAccWei < taxThresholdWei) return;

    uint256 amount = taxAccWei;
    address jb     = butBank;

    if (jb == address(0)) {
      emit TaxFlush(address(0), amount, false);
      return;
    }
    if (HEX.balanceOf(address(this)) < amount) {
      emit TaxFlush(jb, amount, false);
      return;
    }

    bool ok = HEX.transfer(jb, amount);
    if (!ok) {
      emit TaxFlush(jb, amount, false);
      return;
    }

    taxAccWei = 0;
    emit TaxFlush(jb, amount, true);

    if (callbutBankHook) {
      try IbutBank(jb).onTaxReceived(amount) {} catch {}
    }
  }

  function manualFlushTax(uint256 maxAmountWei) external onlyOwner {
    address jb = butBank;
    if (jb == address(0)) revert butBankZero();

    uint256 amount = taxAccWei;
    if (maxAmountWei != 0 && amount > maxAmountWei) amount = maxAmountWei;
    if (amount == 0) revert ZeroAmount();

    if (HEX.balanceOf(address(this)) < amount) revert InsufficientHex();
    if (!HEX.transfer(jb, amount)) revert TransferFail();

    taxAccWei -= amount;
    emit TaxFlush(jb, amount, true);

    if (callbutBankHook) {
      try IbutBank(jb).onTaxReceived(amount) {} catch {}
    }
  }

  // ==========================================================================
  // VIEW HELPERS
  // ==========================================================================

  /// @notice 유저 지갑 HEX의 KRW/USD/VND 환산 (표시 전용, owner 설정 FX 기준)
  function getUserValueScaled(address user) external view returns (
    uint256 hexBalWei,
    uint256 krwValueScaled,
    uint256 usdValueScaled,
    uint256 vndValueScaled,
    uint32  scale
  ) {
    hexBalWei       = HEX.balanceOf(user);
    scale           = fxScale;
    krwValueScaled  = (hexBalWei * fxKrwPerHexScaled) / 1e18;
    usdValueScaled  = (hexBalWei * fxUsdPerHexScaled) / 1e18;
    vndValueScaled  = (hexBalWei * fxVndPerHexScaled) / 1e18;
  }

  /// @notice 준비금 현황.
  ///         reserved = taxAccWei + jackpotAccWei + uplineReserveWei.
  ///         solvent = true 이면 세금 버퍼 + 복권 풀 + 멘토의 멘토 예치금 모두 안전.
  function solvencyReserve() external view returns (
    uint256 tax,
    uint256 jackpot,
    uint256 uplineReserve,
    uint256 reserved,
    uint256 contractBal,
    bool    solvent
  ) {
    tax           = taxAccWei;
    jackpot       = jackpotAccWei;
    uplineReserve = uplineReserveWei;
    reserved      = taxAccWei + jackpotAccWei + uplineReserveWei;
    contractBal   = HEX.balanceOf(address(this));
    solvent       = contractBal >= reserved;
  }
}
