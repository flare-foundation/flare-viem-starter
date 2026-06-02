import { encodeFunctionData } from "viem";
import { Client, Wallet } from "xrpl";
import { MPT_ISSUANCE_ID } from "./config";
import { abi as BridgeAbi } from "../abis/DummyBridge";
import { abi as LendingAbi } from "../abis/DummyLending";
import { abi as ERC20Abi } from "../abis/ERC20";
import {
  executeDirectMintingWithData,
  findUserOperationExecuted,
  getPersonalAccountAddress,
  sendHashInstruction,
  type Call,
} from "../utils/smart-accounts";
import { computeDirectMintingPaymentAmountXrp } from "../utils/fassets";
import { findLatestInitiateBridgeEventInLast30Blocks, transferEventAmountMptToXrplAddress } from "./utils";

// NOTE:(Nik) For this example to work, you first need to faucet C2FLR to your personal account address.
// 0xFE is a three-step protocol; this script runs all three steps inline
// (user → executor → confirmation). With the 42-byte memo cap removed, the
// whole flow — approve FXRP, deposit collateral, take loan, approve USDT,
// initiate bridge — fits in a single user op and runs atomically: if any
// step reverts, none of the prior state changes are kept.
async function main() {
  // Net FXRP amount to mint in XRP. Minting + executor fees are fetched from
  // AssetManagerFXRP and added on top to form the XRPL payment amount.
  const fxrpMintAmount = 10;

  const xrplClient = new Client(process.env.XRPL_TESTNET_RPC_URL!);
  const xrplWallet = Wallet.fromSeed(process.env.XRPL_SEED!);
  const vaultWallet = Wallet.fromSeed(process.env.VAULT_SEED!);

  const loanContractAddress = "0xa5B3E70376B6CdbBfD33bd2af656f3Fada8f017f";
  const dummyUSDTAddress = "0x8A6a67b3edf7A876E107090485681ec71cAdf3bA";
  const bridgeAddress = "0x620864B25471EFEbBd27bFc3239AEB1888fc35b9";

  const FXRPAddress = "0x0b6A3645c240605887a5532109323A3E12273dc7";

  const amountToDeposit = 100;
  const amountToBorrow = 10n;

  const customInstruction: Call[] = [
    {
      target: FXRPAddress,
      value: BigInt(0),
      data: encodeFunctionData({
        abi: ERC20Abi,
        functionName: "approve",
        args: [loanContractAddress, amountToDeposit],
      }),
    },
    {
      target: loanContractAddress,
      value: BigInt(0),
      data: encodeFunctionData({
        abi: LendingAbi,
        functionName: "depositCollateral",
        args: [amountToDeposit],
      }),
    },
    {
      target: loanContractAddress,
      value: BigInt(0),
      data: encodeFunctionData({
        abi: LendingAbi,
        functionName: "takeLoan",
        args: [amountToBorrow],
      }),
    },
    {
      target: dummyUSDTAddress,
      value: BigInt(0),
      data: encodeFunctionData({
        abi: ERC20Abi,
        functionName: "approve",
        args: [bridgeAddress, amountToBorrow],
      }),
    },
    {
      target: bridgeAddress,
      value: BigInt(0),
      data: encodeFunctionData({
        abi: BridgeAbi,
        functionName: "initiateBridge",
        args: [xrplWallet.address, amountToBorrow],
      }),
    },
  ];

  const [personalAccount, paymentAmountXrp] = await Promise.all([
    getPersonalAccountAddress(xrplWallet.address),
    computeDirectMintingPaymentAmountXrp({ netMintAmountXrp: fxrpMintAmount }),
  ]);
  console.log("Personal account address:", personalAccount, "\n");
  console.log("Payment amount (XRP, net mint + fees):", paymentAmountXrp, "\n");

  // --- 1. USER SIDE -------------------------------------------------------
  const userSide = await sendHashInstruction({
    label: "deposit-borrow-bridge",
    customInstruction,
    amountXrp: paymentAmountXrp,
    personalAccount,
    xrplClient,
    xrplWallet,
  });

  // --- 2. EXECUTOR SIDE ---------------------------------------------------
  const { receipt } = await executeDirectMintingWithData({
    xrplTransactionHash: userSide.xrplTransactionHash,
    data: userSide.data,
    value: userSide.totalCallValue,
    xrplClient,
    label: "deposit-borrow-bridge",
  });

  // --- 3. CONFIRMATION ----------------------------------------------------
  findUserOperationExecuted(receipt, personalAccount, userSide.nonce);

  const initiateBridgeEvent = await findLatestInitiateBridgeEventInLast30Blocks({
    bridgeAddress: bridgeAddress as `0x${string}`,
    personalAccountAddress: personalAccount,
  });
  console.log("InitiateBridge event:", initiateBridgeEvent, "\n");

  await transferEventAmountMptToXrplAddress({
    initiateBridgeEvent,
    xrplClient,
    vaultWallet,
    mptIssuanceId: MPT_ISSUANCE_ID,
    assetScale: 6,
    recipientXrplWallet: xrplWallet,
  });
}

void main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
