import { encodeFunctionData } from "viem";
import { Client, Wallet } from "xrpl";
import { abi as MorphoBlueAbi } from "../abis/MorphoBlue";
import {
  executeDirectMintingWithData,
  findUserOperationExecuted,
  getPersonalAccountAddress,
  sendHashInstruction,
  type Call,
} from "../utils/smart-accounts";
import { computeDirectMintingPaymentAmountXrp } from "../utils/fassets";
import { MORPHO_BLUE_ADDRESS, fetchMarketDecimals, getAndLogState, marketId, marketParams } from "./utils";

// NOTE:(Nik) Run after src/morpho/borrow.ts has opened a position. Assumes
// src/morpho/setup.ts has already funded the smart account and approved
// Morpho Blue for both tokens. Empty `data` on repay skips Morpho's callback
// so it pulls loan tokens directly via the approval set up earlier. See
// repay-memo-field.ts for the MorphoMarketShim-based variant the 0xFF flow needs.
//
// 0xFE is a three-step protocol; this script runs all three steps inline.
async function main() {
  const xrplClient = new Client(process.env.XRPL_TESTNET_RPC_URL!);
  const xrplWallet = Wallet.fromSeed(process.env.XRPL_SEED!);

  const [personalAccount, memoOnlyAmountXrp, marketDecimals] = await Promise.all([
    getPersonalAccountAddress(xrplWallet.address),
    computeDirectMintingPaymentAmountXrp({ netMintAmountXrp: 0 }),
    fetchMarketDecimals(),
  ]);

  console.log("Personal account:", personalAccount, "\n");
  console.log("Morpho market id:", marketId, "\n");

  const { borrowShares, collateral } = await getAndLogState("Before repay", personalAccount, marketDecimals);

  if (borrowShares === 0n && collateral === 0n) {
    console.log("Nothing to repay or withdraw. Exiting.");
    return;
  }

  console.log("Repaying full position, borrowShares:", borrowShares.toString(), "\n");

  // Morpho Blue reverts when both assets and shares are zero, and when
  // withdrawCollateral is called with assets=0. Skip either call if its side
  // of the position is already empty.
  const customInstruction: Call[] = [];
  if (borrowShares > 0n) {
    customInstruction.push({
      target: MORPHO_BLUE_ADDRESS,
      value: 0n,
      data: encodeFunctionData({
        abi: MorphoBlueAbi,
        functionName: "repay",
        args: [marketParams, 0n, borrowShares, personalAccount, "0x"],
      }),
    });
  }
  if (collateral > 0n) {
    customInstruction.push({
      target: MORPHO_BLUE_ADDRESS,
      value: 0n,
      data: encodeFunctionData({
        abi: MorphoBlueAbi,
        functionName: "withdrawCollateral",
        args: [marketParams, collateral, personalAccount, personalAccount],
      }),
    });
  }

  // --- 1. USER SIDE -------------------------------------------------------
  const userSide = await sendHashInstruction({
    label: "repay-and-withdraw",
    customInstruction,
    amountXrp: memoOnlyAmountXrp,
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
    label: "repay-and-withdraw",
  });

  // --- 3. CONFIRMATION ----------------------------------------------------
  const event = findUserOperationExecuted(receipt, personalAccount, userSide.nonce);
  console.log("UserOperationExecuted:", event, "\n");

  await getAndLogState("After repay + withdraw", personalAccount, marketDecimals);
}

void main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
