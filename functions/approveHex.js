/**
 * approveHex.js
 * 관리자 지갑으로 jumpPlatform 컨트랙트에 HEX 무한 승인 (최초 1회)
 *
 * 실행: ADMIN_PRIVATE_KEY=0x... node approveHex.js
 */
'use strict';

const { ethers } = require('ethers');

const RPC_URL      = 'https://opbnb-mainnet-rpc.bnbchain.org';
const HEX_ADDRESS  = '0xc159663b769E6c421854E913460b973899B76E42'; // BUT 토큰
const PLATFORM_ADDR= '0x93ded35508F56BA53C5653Eca736aDdfD994AFcd'; // butPlatform

const HEX_ABI = [
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function allowance(address owner, address spender) external view returns (uint256)',
  'function balanceOf(address account) external view returns (uint256)',
];

async function main() {
  const privateKey = process.env.ADMIN_PRIVATE_KEY;
  if (!privateKey) {
    console.error('❌ ADMIN_PRIVATE_KEY 환경변수가 없습니다.');
    console.error('   실행 방법: ADMIN_PRIVATE_KEY=0x... node approveHex.js');
    process.exit(1);
  }

  const provider   = new ethers.JsonRpcProvider(RPC_URL);
  const wallet     = new ethers.Wallet(privateKey, provider);
  const hexContract= new ethers.Contract(HEX_ADDRESS, HEX_ABI, wallet);

  console.log('관리자 지갑:', wallet.address);

  // BNB 잔액 확인
  const bnbBal = await provider.getBalance(wallet.address);
  console.log('BNB 잔액:  ', ethers.formatEther(bnbBal), 'BNB');

  // HEX 잔액 확인
  const hexBal = await hexContract.balanceOf(wallet.address);
  console.log('HEX 잔액:  ', ethers.formatEther(hexBal), 'HEX');

  // 현재 allowance 확인
  const current = await hexContract.allowance(wallet.address, PLATFORM_ADDR);
  console.log('현재 Allowance:', ethers.formatEther(current), 'HEX');

  if (current === ethers.MaxUint256) {
    console.log('✅ 이미 무한 Approve 상태입니다. 별도 작업 불필요.');
    return;
  }

  console.log('\nHEX.approve(jumpPlatform, MaxUint256) 실행 중...');
  const tx = await hexContract.approve(PLATFORM_ADDR, ethers.MaxUint256);
  console.log('트랜잭션 전송됨:', tx.hash);

  const receipt = await tx.wait();
  console.log('✅ 승인 완료!');
  console.log('   txHash:', receipt.hash);
  console.log('   Block: ', receipt.blockNumber);

  // 최종 allowance 재확인
  const after = await hexContract.allowance(wallet.address, PLATFORM_ADDR);
  console.log('   최종 Allowance:', after === ethers.MaxUint256 ? '∞ MaxUint256' : ethers.formatEther(after));
}

main().catch((err) => {
  console.error('❌ 오류:', err.message);
  process.exit(1);
});
