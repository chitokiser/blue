// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);

    function transfer(address recipient, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function transferFrom(address sender, address recipient, uint256 amount) external returns (bool);

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
}

contract but is IERC20 {
    string public constant name = "BlueEco Utility Token";
    string public constant symbol = "but";
    uint8 public constant decimals = 0;

    uint256 private _totalSupply;
    address public admin;

    mapping(address => uint256) private _balances;
    mapping(address => mapping(address => uint256)) private _allowances;

    modifier onlyAdmin() {
        require(msg.sender == admin, "ADMIN");
        _;
    }

    constructor() {
        admin = msg.sender;

        // decimals = 0 → 정확히 10억 개
        _totalSupply = 1_000_000_000;
        _balances[msg.sender] = _totalSupply;

        emit Transfer(address(0), msg.sender, _totalSupply);
    }

    /* ========== ERC20 VIEW ========== */

    function totalSupply() external view override returns (uint256) {
        return _totalSupply;
    }

    function balanceOf(address account) public view override returns (uint256) {
        return _balances[account];
    }

    function allowance(address owner, address spender) public view override returns (uint256) {
        return _allowances[owner][spender];
    }

    /* ========== ERC20 CORE ========== */

    function transfer(address recipient, uint256 amount) external override returns (bool) {
        _transfer(msg.sender, recipient, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external override returns (bool) {
        _approve(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address sender, address recipient, uint256 amount) external override returns (bool) {
        uint256 currentAllowance = _allowances[sender][msg.sender];
        require(currentAllowance >= amount, "ALLOW");

        unchecked {
            _allowances[sender][msg.sender] = currentAllowance - amount;
        }
        emit Approval(sender, msg.sender, _allowances[sender][msg.sender]);

        _transfer(sender, recipient, amount);
        return true;
    }

    /* ========== INTERNAL ========== */

    function _transfer(address from, address to, uint256 amount) internal {
        require(to != address(0), "TO_ZERO");
        require(_balances[from] >= amount, "BAL");

        unchecked {
            _balances[from] -= amount;
            _balances[to] += amount;
        }

        emit Transfer(from, to, amount);
    }

    function _approve(address owner, address spender, uint256 amount) internal {
        require(spender != address(0), "SPENDER_ZERO");
        _allowances[owner][spender] = amount;
        emit Approval(owner, spender, amount);
    }

    /* ========== HELPER ========== */

    function mybalances() external view returns (uint256) {
        return _balances[msg.sender];
    }
}
