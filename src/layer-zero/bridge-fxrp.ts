import { erc20Abi, formatUnits, pad, type Address } from "viem";
import { Options } from "@layerzerolabs/lz-v2-utilities";
import { account, publicClient, walletClient } from "../utils/client";
import { abi as fxrpOftAbi } from "../abis/FXRPOFT";
import { calculateAmountToSend, getFxrpBalance, getFxrpDecimals } from "../utils/fassets";
import { getFxrpAddress } from "../utils/flare-contract-registry";
import { config } from "./config";
import type { SendParam } from "./types";

async function approveSpender(fAssetAddress: Address, spender: Address, amount: bigint) {
  const { request } = await publicClient.simulateContract({
    account,
    address: fAssetAddress,
    abi: erc20Abi,
    functionName: "approve",
    args: [spender, amount],
  });
  const txHash = await walletClient.writeContract(request);
  await publicClient.waitForTransactionReceipt({ hash: txHash });
}

async function approveTokens(fAssetAddress: Address, amountToBridge: bigint, decimals: number) {
  const underlyingToken = await publicClient.readContract({
    address: config.COSTON2_OFT_ADAPTER,
    abi: fxrpOftAbi,
    functionName: "token",
  });
  console.log("\nOFT Adapter underlying token:", underlyingToken);
  console.log("Expected token:", fAssetAddress);
  console.log("Match:", underlyingToken.toLowerCase() === fAssetAddress.toLowerCase());

  console.log("\nApproving FTestXRP for OFT Adapter:", config.COSTON2_OFT_ADAPTER);
  console.log("Amount:", formatUnits(amountToBridge, decimals), "FXRP");
  await approveSpender(fAssetAddress, config.COSTON2_OFT_ADAPTER, amountToBridge);
  console.log("OFT Adapter approved");

  if (config.COSTON2_COMPOSER) {
    console.log("\nApproving FTestXRP for Composer:", config.COSTON2_COMPOSER);
    await approveSpender(fAssetAddress, config.COSTON2_COMPOSER, amountToBridge);
    console.log("Composer approved");
  }
}

function buildSendParam(recipient: Address, amountToBridge: bigint): SendParam {
  const options = Options.newOptions().addExecutorLzReceiveOption(config.EXECUTOR_GAS, 0);

  return {
    dstEid: config.SEPOLIA_EID,
    to: pad(recipient, { size: 32 }),
    amountLD: amountToBridge,
    minAmountLD: amountToBridge,
    extraOptions: options.toHex() as `0x${string}`,
    composeMsg: "0x",
    oftCmd: "0x",
  };
}

async function quoteFee(sendParam: SendParam) {
  const { nativeFee } = await publicClient.readContract({
    address: config.COSTON2_OFT_ADAPTER,
    abi: fxrpOftAbi,
    functionName: "quoteSend",
    args: [sendParam, false],
  });
  console.log("LayerZero Fee:", formatUnits(nativeFee, 18), "C2FLR");
  return nativeFee;
}

async function executeBridge(sendParam: SendParam, nativeFee: bigint, signerAddress: Address) {
  console.log("\nSending FXRP to Sepolia...");

  const { request } = await publicClient.simulateContract({
    account,
    address: config.COSTON2_OFT_ADAPTER,
    abi: fxrpOftAbi,
    functionName: "send",
    args: [sendParam, { nativeFee, lzTokenFee: 0n }, signerAddress],
    value: nativeFee,
  });

  const txHash = await walletClient.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

  console.log("Transaction sent:", txHash);
  console.log("Confirmed in block:", receipt.blockNumber);
  console.log("\nTrack your transaction:");
  console.log(`https://testnet.layerzeroscan.com/tx/${txHash}`);
  console.log("\nIt may take a few minutes to arrive on Sepolia.");
}

async function main() {
  const bridgeLots = process.env.BRIDGE_LOTS ?? "1";
  const signerAddress = account.address;
  const [fAssetAddress, decimals, amountToBridge] = await Promise.all([
    getFxrpAddress(),
    getFxrpDecimals(),
    calculateAmountToSend(BigInt(bridgeLots)),
  ]);

  console.log("Using account:", signerAddress);
  console.log("Token address:", fAssetAddress);
  console.log("Token decimals:", decimals);

  console.log("\nBridge Details:");
  console.log("From: Coston2");
  console.log("To: Sepolia");
  console.log("Amount:", formatUnits(amountToBridge, decimals), "FXRP");
  console.log("Recipient:", signerAddress);

  const balance = await getFxrpBalance(signerAddress);
  console.log("\nYour FTestXRP balance:", formatUnits(balance, decimals));
  if (balance < amountToBridge) {
    throw new Error("Insufficient FTestXRP balance");
  }

  await approveTokens(fAssetAddress, amountToBridge, decimals);

  const sendParam = buildSendParam(signerAddress, amountToBridge);
  const nativeFee = await quoteFee(sendParam);
  await executeBridge(sendParam, nativeFee, signerAddress);
}

void main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
