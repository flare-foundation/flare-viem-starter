import { Client, Wallet } from "xrpl";
import { getPersonalAccountAddress } from "../utils/smart-accounts";
import { computeDirectMintingPaymentAmountXrp } from "../utils/fassets";
import {
  COLLATERAL_TOKEN_ADDRESS,
  LOAN_TOKEN_ADDRESS,
  MORPHO_MARKET_SHIM_ADDRESS,
  ensureShimSetupMemoField,
  fetchMarketDecimals,
  getAndLogState,
  marketId,
  mintMock,
} from "./utils";

// NOTE:(Nik) One-shot init for the Morpho cycle scripts. Funds the smart
// account with mock collateral and loan tokens (mock setBalance is
// permissionless, so the externally owned account can mint to anyone), then sends up to three
// setup memos from the smart account: approve(shim) for both tokens and
// setAuthorization(shim) on Morpho. Idempotent — safe to re-run; each step
// reads on-chain state and skips if already in place.
//
// The loan-token buffer is sized to absorb interest paid across many
// borrow/repay cycles before re-funding is needed. Collateral round-trips
// via supply/withdraw so doesn't drain.
async function main() {
  // 100 units of collateral is exactly the supply size used by borrow-memo-field.ts;
  // 1000 units of loan token gives a generous buffer over the ~85 borrowed
  // (and slightly more repaid due to interest) per cycle.
  const collateralFundingUnits = 100n;
  const loanFundingUnits = 1000n;

  const xrplClient = new Client(process.env.XRPL_TESTNET_RPC_URL!);
  const xrplWallet = Wallet.fromSeed(process.env.XRPL_SEED!);

  const [personalAccount, memoOnlyAmountXrp, marketDecimals] = await Promise.all([
    getPersonalAccountAddress(xrplWallet.address),
    computeDirectMintingPaymentAmountXrp({ netMintAmountXrp: 0 }),
    fetchMarketDecimals(),
  ]);

  console.log("Personal account:", personalAccount, "\n");
  console.log("Morpho market id:", marketId, "\n");
  console.log("Shim address:    ", MORPHO_MARKET_SHIM_ADDRESS, "\n");

  await getAndLogState("Before setup", personalAccount, marketDecimals);

  await mintMock(
    COLLATERAL_TOKEN_ADDRESS,
    personalAccount,
    collateralFundingUnits * 10n ** BigInt(marketDecimals.collateralDecimals)
  );
  await mintMock(LOAN_TOKEN_ADDRESS, personalAccount, loanFundingUnits * 10n ** BigInt(marketDecimals.loanDecimals));
  console.log("Funded smart account with collateral and loan tokens.\n");

  await ensureShimSetupMemoField({ personalAccount, xrplClient, xrplWallet, amountXrp: memoOnlyAmountXrp });

  await getAndLogState("After setup", personalAccount, marketDecimals);
}

void main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
