// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/* ===================== Interfaces ===================== */

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function transfer(address recipient, uint256 amount) external returns (bool);
    function transferFrom(address sender, address recipient, uint256 amount) external returns (bool);
}

// Hutbank에 수익(기록)을 올려주는 인터페이스
interface IHutBankFee {
    function totalfeeup(uint256 amount) external;
}

/*
    butbank.sol

    - but token decimals: 0 (정수 토큰)
    - HEX token decimals: 18
    - price: HEX wei per token
    - price = 0.01 HEX + (hexBalance / effectiveStaked)
    - dividend unit(_allow) = hexBalance / effectiveStaked (BASE_PRICE 미포함)

    거래 정책:
    - buy/sell/claim 모두 "현재 price"로 정산 후, 함수 끝에서 priceUp()을 호출하여
      다음 거래부터 갱신된 가격이 적용되게 함.

    외부 수익:
    - 이 계약은 butbank라서 (대장주 hutbank와 달리) 외부 bank의 totalfeeup 업로드는 보통 쓰지 않지만,
      구조 호환을 위해 family/totalfeeup은 유지.
    - 단, but sell fee는 hutbank에 상납(transfer + hutbank.totalfeeup 기록 업로드)
*/
contract butbank {
    /* ========== Tokens ========== */

    IERC20 public immutable but;

    // hextoken(HEX) 고정 주소 (18 decimals)
    IERC20 public immutable hextoken = IERC20(0x41F2Ea9F4eF7c4E35ba1a8438fC80937eD4E5464);

    // but sell fee 상납처: hutbank
    address public immutable hutbank;
    IHutBankFee public immutable hutFee;

    /* ========== Admin ========== */

    address public admin;

    /* ========== State ========== */

    // 0 stop, 1 buy, 2 buy+div, 3 buy+div+sell
    uint8 public act;

    // UI용 allow (호환)
    uint256 public allow;

    // token 1개 가격 (HEX wei per token)
    uint256 public price;

    // 누적 수수료(HEX wei) - 기록용(내부 sell fee + 외부 bank 업로드)
    uint256 public totalfee;

    // 전체 스테이킹 합계 (token 정수) - 실제 유저 스테이킹만
    uint256 public totalStaked;

    // 가상 스테이킹(초기 안정화용) - 출금/유저 depo와 무관
    uint256 public virtualStaked;

    // 배당 divisor
    uint256 public divisor = 500;

    // 매도 수수료율(%) - admin이 rateup으로 변경
    uint8 public rate;

    uint256 public constant DIV_INTERVAL = 7 days;
    uint256 public constant STAKE_LOCK   = 120 days;

    // 가격 기본값: 0.01 HEX (wei)
    uint256 public constant BASE_PRICE = 1e16;

    // 스테이커 없을 때 표시용 초기 가격
    uint256 public constant INIT_PRICE = BASE_PRICE;

    // 자동 스테이킹 비율 (BPS: 10000 = 100%)
    // 기본 10% = 1000 bps
    uint16 public autoStakeBps = 1000;

    uint256[] private chart;

    // family 권한 (다른 bank 주소 등록)
    mapping(address => uint8) public fa;

    /* ========== User ========== */

    struct UserInfo {
        // 기존 필드(호환)
        uint256 totalAllow;   // 누적 배당 수령(HEX wei)
        uint256 totalBuy;     // 누적 구매 기록(token 수량, 100% 기준)
        uint256 depo;         // 스테이킹 수량(token)
        uint256 stakingTime;  // 마지막 스테이킹 시간
        uint256 lastClaim;    // 마지막 배당 청구 시간

        // 평균 매수가/손익 추적 (BANK 경로 기준)
        uint256 netQty;       // buy/sell로 추적되는 수량
        uint256 avgBuyPrice;  // 평균 매수가(HEX wei per token) - netQty 기준
        uint256 totalPayHex;  // 총 매수 지불액 누적(HEX wei)
        uint256 totalSellHex; // 총 환매 수령액 누적(HEX wei)
    }

    mapping(address => UserInfo) private userInfo;

    /* ========== Events ========== */

    event Bought(
        address indexed who,
        uint256 amount,
        uint256 payHexWei,
        uint256 autoStaked,
        uint256 received
    );

    event Sold(address indexed who, uint256 amount, uint256 recvHexWei, uint256 feeHexWei);
    event Staked(address indexed who, uint256 amount);
    event Withdrawn(address indexed who, uint256 amount);
    event DividendClaimed(address indexed who, uint256 payHexWei);

    event PriceUpdated(uint256 priceHexWeiPerToken);
    event HutFeeUpFailed(uint256 feeHexWei);

    event AutoStakeBpsChanged(uint16 prevBps, uint16 nextBps);

    /* ========== Modifiers ========== */

    modifier onlyAdmin() {
        require(msg.sender == admin, "no admin");
        _;
    }

    /* ========== Constructor ========== */

    constructor(address _but, address _hutbank, uint8 _act) {
        require(_but != address(0), "but zero");
        require(_hutbank != address(0), "hutbank zero");

        but = IERC20(_but);

        hutbank = _hutbank;
        hutFee = IHutBankFee(_hutbank);

        admin = msg.sender;
        act = _act;

        rate = 3;               // 기본 3%
        virtualStaked = 1000;   // 초기 안정화용 가상 스테이킹

        price = INIT_PRICE;
        allow = INIT_PRICE;

        chart.push(price);
        emit PriceUpdated(price);
    }

    /* ===================== Admin funcs (keep) ===================== */

    function familyup(address _fa) external onlyAdmin {
        fa[_fa] = 5;
    }

    function rateup(uint8 _rate) external onlyAdmin {
        rate = _rate;
    }

    // 다른 bank에서 올라오는 수익(기록만). 가격 갱신 없음.
    function totalfeeup(uint256 amount) public {
        require(fa[msg.sender] >= 5, "no family");
        totalfee += amount;
    }

    /* ===================== View Getters ===================== */

    function chartLength() external view returns (uint256) {
        return chart.length;
    }

    function chartAt(uint256 idx) external view returns (uint256) {
        require(idx < chart.length, "idx");
        return chart[idx];
    }

    function hexBalance() public view returns (uint256) {
        return hextoken.balanceOf(address(this));
    }

    function tokenInventory() public view returns (uint256) {
        return but.balanceOf(address(this));
    }

    function effectiveStaked() public view returns (uint256) {
        return totalStaked + virtualStaked;
    }

    function circulatingSupply() public view returns (uint256) {
        return tokenInventory() + totalStaked;
    }

    function user(address who)
        external
        view
        returns (
            uint256 totalAllow_,
            uint256 totalBuy_,
            uint256 depo_,
            uint256 stakingTime_,
            uint256 lastClaim_
        )
    {
        UserInfo storage u = userInfo[who];
        return (u.totalAllow, u.totalBuy, u.depo, u.stakingTime, u.lastClaim);
    }

    function userStatsBase(address who)
        external
        view
        returns (
            uint256 netQty_,
            uint256 avgBuyPriceWei_,
            uint256 totalPayHexWei_,
            uint256 totalSellHexWei_
        )
    {
        UserInfo storage u = userInfo[who];
        return (u.netQty, u.avgBuyPrice, u.totalPayHex, u.totalSellHex);
    }

    function myDashboard(address who)
        external
        view
        returns (
            uint256 myActualQty,
            uint256 currentPriceWei,
            uint256 myMarketCapWei,
            uint256 myAvgBuyPriceWei,
            int256  myPnlWei,
            int256  myRoiBps_
        )
    {
        UserInfo storage u = userInfo[who];

        // 실제 보유(지갑 + 스테이킹)
        myActualQty = but.balanceOf(who) + u.depo;
        currentPriceWei = price;

        // 손익/ROI는 bank buy/sell로 추적되는 netQty 기준
        uint256 trackedQty = u.netQty;
        myMarketCapWei = trackedQty * currentPriceWei;

        myAvgBuyPriceWei = u.avgBuyPrice;

        uint256 costWei = trackedQty * myAvgBuyPriceWei;

        if (myMarketCapWei >= costWei) {
            myPnlWei = int256(myMarketCapWei - costWei);
        } else {
            myPnlWei = -int256(costWei - myMarketCapWei);
        }

        if (costWei == 0) {
            myRoiBps_ = 0;
        } else {
            myRoiBps_ = (myPnlWei * 10000) / int256(costWei);
        }
    }

    function myDashboardSelf()
        external
        view
        returns (
            uint256 myActualQty,
            uint256 currentPriceWei,
            uint256 myMarketCapWei,
            uint256 myAvgBuyPriceWei,
            int256  myPnlWei,
            int256  myRoiBps_
        )
    {
        return this.myDashboard(msg.sender);
    }

    function myAvgBuyPrice(address who) external view returns (uint256) {
        return userInfo[who].avgBuyPrice;
    }

    function myMarketCap(address who) external view returns (uint256) {
        UserInfo storage u = userInfo[who];
        return u.netQty * price;
    }

    function myPnl(address who) external view returns (int256 pnlWei) {
        UserInfo storage u = userInfo[who];
        uint256 qty = u.netQty;

        uint256 mcap = qty * price;
        uint256 cost = qty * u.avgBuyPrice;

        if (mcap >= cost) pnlWei = int256(mcap - cost);
        else pnlWei = -int256(cost - mcap);
    }

    function myRoiBps(address who) external view returns (int256 roiBps) {
        UserInfo storage u = userInfo[who];
        uint256 qty = u.netQty;

        uint256 mcap = qty * price;
        uint256 cost = qty * u.avgBuyPrice;

        if (cost == 0) return 0;

        int256 pnl;
        if (mcap >= cost) pnl = int256(mcap - cost);
        else pnl = -int256(cost - mcap);

        roiBps = (pnl * 10000) / int256(cost);
    }

    /* ===================== Price Logic ===================== */

    function priceUp() public returns (uint256) {
        uint256 p;
        uint256 es = effectiveStaked();

        if (es == 0) {
            p = BASE_PRICE;
        } else {
            uint256 dynamicPart = hexBalance() / es;
            p = BASE_PRICE + dynamicPart;
        }

        if (p < BASE_PRICE) p = BASE_PRICE;

        price = p;
        allow = p;

        chart.push(p);
        emit PriceUpdated(p);
        return p;
    }

    /* ===================== Internal: Avg Buy Update ===================== */

    function _updateAvgOnBuy(address who, uint256 buyQty, uint256 payWei) internal {
        UserInfo storage u = userInfo[who];

        uint256 oldQty = u.netQty;
        uint256 newQty = oldQty + buyQty;

        if (newQty == 0) {
            u.avgBuyPrice = 0;
            u.netQty = 0;
            return;
        }

        uint256 oldCost = oldQty * u.avgBuyPrice;
        uint256 newCost = oldCost + payWei;

        u.avgBuyPrice = newCost / newQty;
        u.netQty = newQty;

        u.totalPayHex += payWei;
    }

    function _reduceQtyOnSell(address who, uint256 sellQty, uint256 recvWei) internal {
        UserInfo storage u = userInfo[who];

        if (sellQty >= u.netQty) {
            u.netQty = 0;
            u.avgBuyPrice = 0;
        } else {
            u.netQty -= sellQty;
        }

        u.totalSellHex += recvWei;
    }

    /* ===================== Buy ===================== */

    function buy(uint256 amount, uint256 maxPay) external returns (bool) {
        require(act >= 1, "not for sale");

        // 대량 매수 방지 캡 (effectiveStaked의 10%)
        uint256 cap = effectiveStaked() / 10;
        require(amount >= 1 && amount <= cap, "buy cap");

        uint256 pay = amount * price;

        if (maxPay != 0) {
            require(pay <= maxPay, "slippage");
        }

        require(tokenInventory() >= amount, "sold out");
        require(hextoken.allowance(msg.sender, address(this)) >= pay, "allowance low");
        require(hextoken.transferFrom(msg.sender, address(this), pay), "hex transfer fail");

        _updateAvgOnBuy(msg.sender, amount, pay);

        // 자동 스테이킹(BPS)
        uint256 autoStake = (amount * uint256(autoStakeBps)) / 10000;
        if (autoStake >= amount) autoStake = amount - 1;

        uint256 userReceive = amount - autoStake;

        if (userReceive > 0) {
            require(but.transfer(msg.sender, userReceive), "token transfer fail");
        }

        UserInfo storage u = userInfo[msg.sender];

        if (autoStake > 0) {
            u.depo += autoStake;
            u.stakingTime = block.timestamp;
            totalStaked += autoStake;
        }

        if (u.lastClaim == 0) u.lastClaim = block.timestamp;

        u.totalBuy += amount;

        emit Bought(msg.sender, amount, pay, autoStake, userReceive);

        // 다음 거래부터 적용
        priceUp();
        return true;
    }

    /* ===================== Sell ===================== */

    function sell(uint256 amount) external returns (bool) {
        require(act >= 3, "cant sell");
        require(amount >= 1, "min 1");

        uint256 gross = amount * price;
        require(hexBalance() >= gross, "hex low");

        uint256 fee = (gross * uint256(rate)) / 100;
        uint256 recvPay = gross - fee;

        require(but.allowance(msg.sender, address(this)) >= amount, "allowance low");
        require(but.transferFrom(msg.sender, address(this), amount), "token transfer fail");

        require(hextoken.transfer(msg.sender, recvPay), "hex transfer fail");

        if (fee > 0) {
            // 핵심 차이점: sell fee를 hutbank로 상납
            require(hextoken.transfer(hutbank, fee), "fee transfer fail");
            totalfee += fee;

            // hutbank에 기록 업로드(실패해도 sell은 성공 처리)
            try hutFee.totalfeeup(fee) {
            } catch {
                emit HutFeeUpFailed(fee);
            }
        }

        _reduceQtyOnSell(msg.sender, amount, recvPay);

        emit Sold(msg.sender, amount, recvPay, fee);

        // 다음 거래부터 적용
        priceUp();
        return true;
    }

    /* ===================== Stake / Withdraw ===================== */

    function stake(uint256 amount) external returns (bool) {
        require(amount >= 1, "min 1");

        require(but.allowance(msg.sender, address(this)) >= amount, "allowance low");
        require(but.transferFrom(msg.sender, address(this), amount), "token transfer fail");

        UserInfo storage u = userInfo[msg.sender];
        u.depo += amount;
        u.stakingTime = block.timestamp;
        totalStaked += amount;

        if (u.lastClaim == 0) u.lastClaim = block.timestamp;

        emit Staked(msg.sender, amount);
        return true;
    }

    function withdraw() external returns (bool) {
        UserInfo storage u = userInfo[msg.sender];
        uint256 amount = u.depo;

        require(amount > 0, "no staking");
        require(block.timestamp >= u.stakingTime + STAKE_LOCK, "locked");

        u.depo = 0;

        require(totalStaked >= amount, "stake accounting");
        totalStaked -= amount;

        require(but.transfer(msg.sender, amount), "token transfer fail");

        emit Withdrawn(msg.sender, amount);
        return true;
    }

    /* ===================== Dividend ===================== */

    function pendingDividend(address who) public view returns (uint256) {
        UserInfo storage u = userInfo[who];
        if (u.depo == 0) return 0;

        uint256 es = effectiveStaked();
        if (es == 0) return 0;

        uint256 _allow = hexBalance() / es;
        if (_allow == 0) return 0;

        uint256 d = divisor;
        if (d == 0) return 0;

        return (u.depo * _allow) / d;
    }

    function claimDividend() external returns (bool) {
        require(act >= 2, "no dividend");

        UserInfo storage u = userInfo[msg.sender];
        require(u.depo > 0, "no staking");
        require(block.timestamp >= u.lastClaim + DIV_INTERVAL, "not time");

        uint256 pay = pendingDividend(msg.sender);
        require(pay > 0, "zero");
        require(hexBalance() >= pay, "hex low");

        u.lastClaim = block.timestamp;
        u.totalAllow += pay;

        require(hextoken.transfer(msg.sender, pay), "hex transfer fail");

        emit DividendClaimed(msg.sender, pay);

        // 다음 거래부터 적용
        priceUp();
        return true;
    }

    /* ===================== Admin ===================== */

    function setAct(uint8 a) external onlyAdmin {
        act = a;
    }

    function setDivisor(uint256 d) external onlyAdmin {
        require(d > 0, "div 0");
        divisor = d;
    }

    function transferAdmin(address next) external onlyAdmin {
        require(next != address(0), "zero");
        admin = next;
    }

    function setAutoStakeBps(uint16 nextBps) external onlyAdmin {
        require(nextBps <= 10000, "bps");
        uint16 prev = autoStakeBps;
        autoStakeBps = nextBps;
        emit AutoStakeBpsChanged(prev, nextBps);
    }
}
