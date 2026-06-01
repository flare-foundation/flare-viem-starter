import { encodeFunctionData, formatUnits } from "viem";
import { Client, Wallet } from "xrpl";
import { abi as MorphoMarketShimAbi } from "../abis/MorphoMarketShim";
import { publicClient } from "../utils/client";
import { getPersonalAccountAddress, sendMemoFieldInstruction } from "../utils/smart-accounts";
import { computeDirectMintingPaymentAmountXrp } from "../utils/fassets";
import {
  LLTV,
  MORPHO_MARKET_SHIM_ADDRESS,
  ORACLE_ABI,
  ORACLE_ADDRESS,
  WAD,
  fetchMarketDecimals,
  getAndLogState,
  marketId,
} from "./utils";

// NOTE:(Nik) Run src/morpho/setup-memo-field.ts once before this script — it funds the
// smart account with mock collateral and loan tokens, approves the shim for
// both, and authorizes the shim on Morpho. Without setup, this script's
// user operation will revert.
//
// Architecture: the smart account is the actor end-to-end. A MorphoMarketShim
// pins the 5-field MarketParams in immutable state, so each shim call fits
// inside an XRPL memo (~842 bytes vs the 1024-byte cap). The shim's
// `supplyAndBorrow` bundles both Morpho ops on-chain so a full open step is
// a single memo — two separate Morpho ops in one memo would exceed the cap.
// Borrowed loan tokens go to the smart account itself (receiver=personalAccount),
// keeping the position fully self-contained.
//
// Run src/morpho/repay-memo-field.ts afterwards to close the position.
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
  console.log("Shim address:    ", MORPHO_MARKET_SHIM_ADDRESS, "\n");

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

  await sendMemoFieldInstruction({
    label: "supply-and-borrow",
    customInstruction: [
      {
        target: MORPHO_MARKET_SHIM_ADDRESS,
        value: 0n,
        data: encodeFunctionData({
          abi: MorphoMarketShimAbi,
          functionName: "supplyAndBorrow",
          args: [collateralAssets, borrowAssets, personalAccount],
        }),
      },
    ],
    amountXrp: memoOnlyAmountXrp,
    personalAccount,
    xrplClient,
    xrplWallet,
  });

  await getAndLogState("After borrow", personalAccount, marketDecimals);
}

void main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
