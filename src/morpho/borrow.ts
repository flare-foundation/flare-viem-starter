import { encodeFunctionData, formatUnits } from "viem";
import { Client, Wallet } from "xrpl";
import { abi as MorphoBlueAbi } from "../abis/MorphoBlue";
import { publicClient } from "../utils/client";
import {
  executeDirectMintingWithData,
  findUserOperationExecuted,
  getPersonalAccountAddress,
  sendHashInstruction,
} from "../utils/smart-accounts";
import { computeDirectMintingPaymentAmountXrp } from "../utils/fassets";
import {
  LLTV,
  MORPHO_BLUE_ADDRESS,
  ORACLE_ABI,
  ORACLE_ADDRESS,
  WAD,
  fetchMarketDecimals,
  getAndLogState,
  marketId,
  marketParams,
} from "./utils";

// NOTE:(Nik) Run src/morpho/setup.ts once before this script — it funds the
// smart account with mock collateral and loan tokens and approves Morpho Blue
// for both. Without setup, this script's user operation will revert.
//
// msg.sender on each Morpho call is the personal account itself, so
// msg.sender == onBehalf and no setAuthorization is required. Borrowed loan
// tokens go to the smart account (receiver=personalAccount), keeping the
// position fully self-contained. See borrow-memo-field.ts for the MorphoMarketShim-
// based variant the 0xFF flow needs under the 1024-byte memo cap.
//
// 0xFE is a three-step protocol; this script runs all three steps inline.
// In production the user side and executor side are separate actors.
async function main() {
  const xrplClient = new Client(process.env.XRPL_TESTNET_RPC_URL!);
  const xrplWallet = Wallet.fromSeed(process.env.XRPL_SEED!);

  const [personalAccount, memoOnlyAmountXrp, marketDecimals, oraclePrice] = await Promise.all([
    getPersonalAccountAddress(xrplWallet.address),
    computeDirectMintingPaymentAmountXrp({ netMintAmountXrp: 0 }),
    fetchMarketDecimals(),
    publicClient.readContract({ address: ORACLE_ADDRESS, abi: ORACLE_ABI, functionName: "price" }),
  ]);
  const { loanDecimals, collateralDecimals, oraclePriceScale } = marketDecimals;
  const collateralAssets = 100n * 10n ** BigInt(collateralDecimals);

  console.log("Personal account:", personalAccount, "\n");
  console.log("Morpho market id:", marketId, "\n");

  await getAndLogState("Before borrow", personalAccount, marketDecimals);

  // Compute the max borrow off-chain via Morpho Blue's _isHealthy formula:
  //   maxBorrowAssets = collateral * oraclePrice * lltv / (oraclePriceScale * WAD)
  // 1 % safety margin absorbs interest accrued during the borrow transaction.
  const maxBorrowAssets = (collateralAssets * oraclePrice * LLTV) / (oraclePriceScale * WAD);
  const borrowAssets = (maxBorrowAssets * 99n) / 100n;
  console.log("Oracle price:", oraclePrice.toString());
  console.log(
    "Max borrowable:",
    formatUnits(maxBorrowAssets, loanDecimals),
    "→ borrowing:",
    formatUnits(borrowAssets, loanDecimals),
    "\n"
  );

  // --- 1. USER SIDE -------------------------------------------------------
  const userSide = await sendHashInstruction({
    label: "supply-and-borrow",
    customInstruction: [
      {
        target: MORPHO_BLUE_ADDRESS,
        value: 0n,
        data: encodeFunctionData({
          abi: MorphoBlueAbi,
          functionName: "supplyCollateral",
          args: [marketParams, collateralAssets, personalAccount, "0x"],
        }),
      },
      {
        target: MORPHO_BLUE_ADDRESS,
        value: 0n,
        data: encodeFunctionData({
          abi: MorphoBlueAbi,
          functionName: "borrow",
          args: [marketParams, borrowAssets, 0n, personalAccount, personalAccount],
        }),
      },
    ],
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
    label: "supply-and-borrow",
  });

  // --- 3. CONFIRMATION ----------------------------------------------------
  const event = findUserOperationExecuted(receipt, personalAccount, userSide.nonce);
  console.log("UserOperationExecuted:", event, "\n");

  await getAndLogState("After borrow", personalAccount, marketDecimals);
}

void main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
