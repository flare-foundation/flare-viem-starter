/**
 * Recovery after a failed direct mint using the 0xE0 (skip memo) opcode.
 *
 * Usage:
 *   # Full demo: create a stuck 0xFE payment, then recover it
 *   pnpm run script src/recover-direct-mint-transaction.ts
 *
 *   # Recovery only: reuse an existing stuck XRPL payment
 *   STUCK_XRPL_TX_HASH=<hash> pnpm run script src/recover-direct-mint-transaction.ts
 *
 *   # 0xFE stuck flow: also pass the original PackedUserOperation bytes
 *   STUCK_XRPL_TX_HASH=<hash> STUCK_USER_OP_DATA=0x... pnpm run script src/recover-direct-mint-transaction.ts
 *
 *   # Resume after the 0xE0 recovery payment was already sent on XRPL
 *   STUCK_XRPL_TX_HASH=<hash> RECOVERY_XRPL_TX_HASH=<hash> pnpm run script src/recover-direct-mint-transaction.ts
 *
 * Required in .env: XRPL_SEED, XRPL_TESTNET_RPC_URL, PRIVATE_KEY (executor calls on Flare).
 */

import { encodeFunctionData } from "viem";
import { Client, Wallet } from "xrpl";
import { abi as checkpointAbi } from "./abis/Checkpoint";
import {
  diagnoseStuckDirectMint,
  executeDirectMintingWithData,
  findDirectMintingReceiptForTransactionId,
  findIgnoreMemoSet,
  getPersonalAccountAddress,
  isStuckTransactionIdUsed,
  logPersonalAccountFxrpCredit,
  normalizeXrplTransactionId,
  sendHashInstruction,
  sendSkipMemoInstruction,
  type Call,
} from "./utils/smart-accounts";
import { computeDirectMintingPaymentAmountXrp, getFxrpBalance } from "./utils/fassets";
import { getXrpBalance } from "./utils/xrpl";

// Canonical on-chain flow:
//   1. USER SIDE      — XRPL payment with 0xE0 memo targeting the stuck tx ID.
//   2. EXECUTOR SIDE  — finalize the recovery payment → IgnoreMemoSet.
//   3. EXECUTOR SIDE  — finalize the stuck payment; ignoreMemo skips memo execution.
//
// Recovery mints FXRP to your personal account — not native XRP. To get XRP
// back on XRPL, redeem FXRP via standard FAssets instructions (0x02) or
// AssetManager.redeem after recovery completes.

// Net XRP for demo stuck payment only (ignored when STUCK_XRPL_TX_HASH is set).
const FXRP_MINT_AMOUNT = 10;
// Net XRP for the 0xE0 recovery payment.
const RECOVERY_NET_MINT_XRP = 1;
// XRPL wallet seed (set in .env when running via `pnpm run script`).
const XRPL_SEED = process.env.XRPL_SEED!;

async function main({
  fxrpMintAmount,
  recoveryNetMintAmountXrp,
  xrplSeed,
}: {
  fxrpMintAmount: number;
  recoveryNetMintAmountXrp: number;
  xrplSeed: string;
}) {
  const xrplClient = new Client(process.env.XRPL_TESTNET_RPC_URL!);
  const xrplWallet = Wallet.fromSeed(xrplSeed);

  const [personalAccount, paymentAmountXrp, recoveryPaymentAmountXrp] = await Promise.all([
    getPersonalAccountAddress(xrplWallet.address),
    computeDirectMintingPaymentAmountXrp({ netMintAmountXrp: fxrpMintAmount }),
    computeDirectMintingPaymentAmountXrp({ netMintAmountXrp: recoveryNetMintAmountXrp }),
  ]);
  console.log("Personal account address:", personalAccount, "\n");

  const balanceBefore = await getFxrpBalance(personalAccount);
  console.log("FXRP balance before recovery:", balanceBefore, "\n");

  let stuckXrplTxHash = process.env.STUCK_XRPL_TX_HASH?.trim();
  let stuckUserOpData = process.env.STUCK_USER_OP_DATA?.trim() as `0x${string}` | undefined;

  if (!stuckXrplTxHash) {
    console.log("=== DEMO: creating stuck direct mint (0xFE, executor not called) ===\n");

    const checkpointAddress = "0xEE6D54382aA623f4D16e856193f5f8384E487002";
    const customInstruction: Call[] = [
      {
        target: checkpointAddress,
        value: 0n,
        data: encodeFunctionData({
          abi: checkpointAbi,
          functionName: "passCheckpoint",
          args: [],
        }),
      },
    ];

    const xrpBalance = await getXrpBalance(xrplWallet.address, xrplClient);
    console.log("XRPL wallet XRP balance:", xrpBalance, "\n");
    if (xrpBalance < paymentAmountXrp) {
      throw new Error(
        `Insufficient XRP balance on ${xrplWallet.address}: have ${xrpBalance} XRP, need ${paymentAmountXrp} XRP`
      );
    }

    // --- USER SIDE (demo) ---------------------------------------------------
    // Send the 0xFE XRPL payment but deliberately skip the executor step so
    // XRP sits at the Core Vault unminted on Flare.
    const userSide = await sendHashInstruction({
      label: "stuck-demo",
      customInstruction,
      amountXrp: paymentAmountXrp,
      personalAccount,
      xrplClient,
      xrplWallet,
    });
    stuckXrplTxHash = userSide.xrplTransactionHash;
    stuckUserOpData = userSide.data;
    console.log("Stuck XRPL transaction hash (save for recovery-only mode):", stuckXrplTxHash, "\n");
  } else {
    console.log("=== RECOVERY ONLY: using STUCK_XRPL_TX_HASH ===\n");
    console.log("Stuck XRPL transaction hash:", stuckXrplTxHash, "\n");
    if (!stuckUserOpData) {
      console.warn(
        "STUCK_USER_OP_DATA not set — assuming 0xFF stuck flow or memo already skipped. " +
          "For 0xFE stuck payments, set STUCK_USER_OP_DATA to the original PackedUserOperation bytes.\n"
      );
    }
  }

  // --- Step 0: Diagnose -----------------------------------------------------
  const diagnosis = await diagnoseStuckDirectMint({
    stuckXrplTxHash,
    personalAccount,
  });
  if (diagnosis.transactionIdUsed) {
    throw new Error(
      `Stuck transaction ${diagnosis.targetTxId} is already minted on Flare — 0xE0 recovery does not apply.`
    );
  }

  const xrpBalance = await getXrpBalance(xrplWallet.address, xrplClient);
  console.log("XRPL wallet XRP balance:", xrpBalance, "\n");
  const existingRecoveryXrplTxHash = process.env.RECOVERY_XRPL_TX_HASH?.trim();
  if (!existingRecoveryXrplTxHash && xrpBalance < recoveryPaymentAmountXrp) {
    throw new Error(
      `Insufficient XRP for recovery payment on ${xrplWallet.address}: ` +
        `have ${xrpBalance} XRP, need ${recoveryPaymentAmountXrp} XRP`
    );
  }

  console.log("=== RECOVERY: 0xE0 skip-memo flow ===\n");

  // --- Step 1: USER SIDE — 0xE0 skip-memo payment -------------------------
  let skipMemo: { xrplTransactionHash: string; targetTxId: `0x${string}` };

  if (existingRecoveryXrplTxHash) {
    console.log("Using existing recovery XRPL payment from RECOVERY_XRPL_TX_HASH:", existingRecoveryXrplTxHash, "\n");
    skipMemo = {
      xrplTransactionHash: existingRecoveryXrplTxHash,
      targetTxId: normalizeXrplTransactionId(stuckXrplTxHash),
    };
  } else {
    skipMemo = await sendSkipMemoInstruction({
      label: "skip-memo",
      targetXrplTxHash: stuckXrplTxHash,
      personalAccount,
      xrplClient,
      xrplWallet,
      recoveryNetMintAmountXrp,
    });
  }

  // --- Step 2: EXECUTOR SIDE — finalize recovery payment --------------------
  const targetTxId = skipMemo.targetTxId;
  const recoveryPaymentTxId = normalizeXrplTransactionId(skipMemo.xrplTransactionHash);
  const skipMemoExecutorLabel = "skip-memo-executor";
  let recoveryReceipt;

  if (await isStuckTransactionIdUsed(recoveryPaymentTxId)) {
    console.log(
      "Recovery XRPL payment already minted on Flare (likely by a relayer) — loading existing receipt.\n"
    );
    recoveryReceipt = await findDirectMintingReceiptForTransactionId(recoveryPaymentTxId, {
      label: skipMemoExecutorLabel,
    });
  } else {
    ({ receipt: recoveryReceipt } = await executeDirectMintingWithData({
      xrplTransactionHash: skipMemo.xrplTransactionHash,
      data: "0x",
      value: 0n,
      xrplClient,
      label: skipMemoExecutorLabel,
      reuseExistingMint: true,
    }));
  }

  const ignoreMemoSet = findIgnoreMemoSet(recoveryReceipt, personalAccount, targetTxId);
  console.log("IgnoreMemoSet event:", ignoreMemoSet, "\n");

  logPersonalAccountFxrpCredit({
    label: skipMemoExecutorLabel,
    receipt: recoveryReceipt,
    personalAccount,
    xrplTransactionId: recoveryPaymentTxId,
  });

  // A relayer may have finalized the stuck payment while we were recovering.
  const stillStuck = !(await isStuckTransactionIdUsed(diagnosis.targetTxId));
  if (!stillStuck) {
    console.log(
      "Stuck transaction was minted on Flare during recovery (likely by a relayer). " +
        "Loading mint receipt instead of re-submitting.\n"
    );
    const stuckReceipt = await findDirectMintingReceiptForTransactionId(diagnosis.targetTxId, {
      label: "stuck-retry",
    });
    logPersonalAccountFxrpCredit({
      label: "stuck-retry",
      receipt: stuckReceipt,
      personalAccount,
      xrplTransactionId: diagnosis.targetTxId,
    });
  } else {
    // --- Step 3: EXECUTOR SIDE — re-submit original stuck payment ---------------
    // ignoreMemo is set — memo execution is skipped; _data can be empty on Coston2.
    const stuckExecutorLabel = "stuck-retry";
    const { receipt: stuckReceipt } = await executeDirectMintingWithData({
      xrplTransactionHash: stuckXrplTxHash,
      data: stuckUserOpData ?? "0x",
      value: 0n,
      xrplClient,
      label: stuckExecutorLabel,
      reuseExistingMint: true,
    });

    logPersonalAccountFxrpCredit({
      label: stuckExecutorLabel,
      receipt: stuckReceipt,
      personalAccount,
      xrplTransactionId: diagnosis.targetTxId,
    });
  }

  // --- Step 4: Verify -------------------------------------------------------
  const balanceAfter = await getFxrpBalance(personalAccount);
  console.log("FXRP balance after recovery:", balanceAfter, "\n");
  console.log("FXRP recovered:", balanceAfter - balanceBefore, "\n");
}

void main({
  fxrpMintAmount: FXRP_MINT_AMOUNT,
  recoveryNetMintAmountXrp: RECOVERY_NET_MINT_XRP,
  xrplSeed: XRPL_SEED,
})
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
