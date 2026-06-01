import { encodeFunctionData, erc20Abi, formatUnits, pad, type Address } from "viem";
import { Client, Wallet, xrpToDrops } from "xrpl";
import { Options } from "@layerzerolabs/lz-v2-utilities";
import { EndpointId } from "@layerzerolabs/lz-definitions";
import { account, publicClient, sepoliaPublicClient } from "../utils/client";
import {
  executeDirectMintingWithData,
  findUserOperationExecuted,
  getPersonalAccountAddress,
  sendHashInstruction,
  type Call,
} from "../utils/smart-accounts";
import { computeDirectMintingPaymentAmountXrp, getFxrpDecimals } from "../utils/fassets";
import { getFxrpAddress } from "../utils/flare-contract-registry";
import { abi as fxrpOftAbi } from "../abis/FXRPOFT";
import type { SendParam } from "./types";

// Coston2 OFT Adapter for the FXRP → Sepolia route. The adapter exposes the
// LayerZero IOFT interface (send / quoteSend) directly, so the 0xFE flow can
// drive it without a memo-cap shim.
const OFT_ADAPTER_COSTON2: Address = "0xCd3d2127935Ae82Af54Fc31cCD9D3440dbF46639";
const SEPOLIA_DST_EID = EndpointId.SEPOLIA_V2_TESTNET;
const EXECUTOR_GAS = 200_000;

const CONFIG = {
  SEPOLIA_FXRP_OFT: process.env.SEPOLIA_FXRP_OFT as Address | undefined,
  FXRP_MINT_AMOUNT_XRP: 10,
} as const;

const SEPOLIA_ARRIVAL_TIMEOUT_MS = 10 * 60 * 1000;
const SEPOLIA_ARRIVAL_POLL_INTERVAL_MS = 10_000;

async function waitForOftReceivedOnSepolia({
  oftAddress,
  toAddress,
  fromBlock,
}: {
  oftAddress: Address;
  toAddress: Address;
  fromBlock: bigint;
}) {
  const deadline = Date.now() + SEPOLIA_ARRIVAL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const logs = await sepoliaPublicClient.getContractEvents({
      address: oftAddress,
      abi: fxrpOftAbi,
      eventName: "OFTReceived",
      args: { toAddress },
      fromBlock,
      strict: true,
    });
    if (logs.length > 0) {
      return logs[0]!;
    }
    await new Promise((resolve) => setTimeout(resolve, SEPOLIA_ARRIVAL_POLL_INTERVAL_MS));
  }
  throw new Error(`OFTReceived event not observed on Sepolia within ${SEPOLIA_ARRIVAL_TIMEOUT_MS}ms`);
}

// NOTE:(Nik) For this example to work, you first need to faucet C2FLR to your personal account address.
// 0xFE is a three-step protocol; this script runs all three steps inline.
//
// The personal account drives the OFT Adapter directly — 0xFE's 42-byte memo
// removes the calldata-size constraint that the memo-field flow needs a shim
// to satisfy.
//
// The total call.value (the LayerZero nativeFee) is forwarded as msg.value in
// step 2, so it flows AssetManager → MasterAccountController → PersonalAccount
// → OFT Adapter. Unused native fee is refunded by the adapter to the personal
// account (the refund address we pass to `send`).
async function main() {
  if (!CONFIG.SEPOLIA_FXRP_OFT) {
    throw new Error("SEPOLIA_FXRP_OFT env var is required (address of the FXRP OFT on Sepolia)");
  }
  const sepoliaOft = CONFIG.SEPOLIA_FXRP_OFT;

  const xrplClient = new Client(process.env.XRPL_TESTNET_RPC_URL!);
  const xrplWallet = Wallet.fromSeed(process.env.XRPL_SEED!);
  const recipient = account.address;

  const [personalAccount, fxrpAddress, fxrpDecimals, paymentAmountXrp] = await Promise.all([
    getPersonalAccountAddress(xrplWallet.address),
    getFxrpAddress(),
    getFxrpDecimals(),
    computeDirectMintingPaymentAmountXrp({
      netMintAmountXrp: CONFIG.FXRP_MINT_AMOUNT_XRP,
    }),
  ]);

  const amountToBridge = BigInt(xrpToDrops(CONFIG.FXRP_MINT_AMOUNT_XRP));
  const extraOptions = Options.newOptions()
    .addExecutorLzReceiveOption(EXECUTOR_GAS, 0)
    .toHex() as `0x${string}`;
  const sendParam: SendParam = {
    dstEid: SEPOLIA_DST_EID,
    to: pad(recipient, { size: 32 }),
    amountLD: amountToBridge,
    minAmountLD: amountToBridge,
    extraOptions,
    composeMsg: "0x",
    oftCmd: "0x",
  };

  const messagingFee = await publicClient.readContract({
    address: OFT_ADAPTER_COSTON2,
    abi: fxrpOftAbi,
    functionName: "quoteSend",
    args: [sendParam, false],
  });
  const nativeFee = messagingFee.nativeFee;

  console.log("Personal account:", personalAccount);
  console.log("FXRP token:", fxrpAddress);
  console.log("OFT Adapter (Coston2):", OFT_ADAPTER_COSTON2);

  console.log("\nCross-chain mint details:");
  console.log("From (XRPL):", xrplWallet.address);
  console.log("Via (Coston2 personal account):", personalAccount);
  console.log("To (Sepolia):", recipient);
  console.log("Net FXRP to mint & bridge:", formatUnits(amountToBridge, fxrpDecimals), "FXRP");
  console.log("XRPL payment amount (mint + fees):", paymentAmountXrp, "XRP");
  console.log("LayerZero native fee:", formatUnits(nativeFee, 18), "C2FLR");

  const customInstruction: Call[] = [
    {
      target: fxrpAddress,
      value: 0n,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [OFT_ADAPTER_COSTON2, amountToBridge],
      }),
    },
    {
      target: OFT_ADAPTER_COSTON2,
      value: nativeFee,
      data: encodeFunctionData({
        abi: fxrpOftAbi,
        functionName: "send",
        args: [sendParam, { nativeFee, lzTokenFee: 0n }, personalAccount],
      }),
    },
  ];

  // Sample the Sepolia block height before the bridge runs so we don't miss
  // the OFTReceived event if the LayerZero delivery is unusually fast.
  const startSepoliaBlock = await sepoliaPublicClient.getBlockNumber();

  // --- 1. USER SIDE -------------------------------------------------------
  const userSide = await sendHashInstruction({
    label: "mint-approve-and-bridge",
    customInstruction,
    amountXrp: paymentAmountXrp,
    personalAccount,
    xrplClient,
    xrplWallet,
  });

  // --- 2. EXECUTOR SIDE ---------------------------------------------------
  const { hash: executorTxHash, receipt } = await executeDirectMintingWithData({
    xrplTransactionHash: userSide.xrplTransactionHash,
    data: userSide.data,
    value: userSide.totalCallValue,
    xrplClient,
    label: "mint-approve-and-bridge",
  });

  // --- 3. CONFIRMATION ----------------------------------------------------
  const event = findUserOperationExecuted(receipt, personalAccount, userSide.nonce);
  console.log("UserOperationExecuted:", event, "\n");

  console.log("\nTrack your cross-chain transaction:");
  console.log(`https://testnet.layerzeroscan.com/tx/${executorTxHash}`);
  console.log("\nWaiting for FXRP to arrive on Sepolia (this can take a few minutes)...");

  const arrivalEvent = await waitForOftReceivedOnSepolia({
    oftAddress: sepoliaOft,
    toAddress: recipient,
    fromBlock: startSepoliaBlock,
  });

  console.log("\nFXRP arrived on Sepolia:");
  console.log("  Tx hash:", arrivalEvent.transactionHash);
  console.log("  Amount received:", formatUnits(arrivalEvent.args.amountReceivedLD, fxrpDecimals), "FXRP");
  console.log("  Recipient:", arrivalEvent.args.toAddress);
}

void main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
