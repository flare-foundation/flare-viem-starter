import { Client, Wallet } from "xrpl";
import {
  executeDirectMintingWithData,
  findUserOperationExecuted,
  getPersonalAccountAddress,
} from "../utils/smart-accounts";
import { computeDirectMintingPaymentAmountXrp } from "../utils/fassets";
import {
  COLLATERAL_TOKEN_ADDRESS,
  LOAN_TOKEN_ADDRESS,
  buildMorphoSetupUserSide,
  fetchMarketDecimals,
  getAndLogState,
  marketId,
  mintMock,
} from "./utils";

// NOTE:(Nik) 0xFE counterpart of src/morpho/setup-memo-field.ts. The 0xFE memo is a
// constant 42 bytes, so the smart account can call Morpho Blue directly
// without the MorphoMarketShim that setup-memo-field.ts needs to fit calls under the
// 1024-byte memo cap. Setup is therefore just two approvals (collateral and
// loan token) to Morpho Blue; no setAuthorization is needed because msg.sender
// on each Morpho call is the personal account itself. Both approvals collapse
// into a single hash-instruction batch. Funds the smart account with mock
// collateral and loan tokens (mock setBalance is permissionless, so the
// externally owned account can mint to anyone), then runs the 0xFE three-step
// protocol (user → executor → confirmation) for the remaining approvals.
// Idempotent — safe to re-run; reads on-chain state and skips entirely if
// already in place.
async function main() {
  // 100 units of collateral is exactly the supply size used by borrow.ts;
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

  await getAndLogState("Before setup", personalAccount, marketDecimals);

  await mintMock(
    COLLATERAL_TOKEN_ADDRESS,
    personalAccount,
    collateralFundingUnits * 10n ** BigInt(marketDecimals.collateralDecimals)
  );
  await mintMock(LOAN_TOKEN_ADDRESS, personalAccount, loanFundingUnits * 10n ** BigInt(marketDecimals.loanDecimals));
  console.log("Funded smart account with collateral and loan tokens.\n");

  // --- 1. USER SIDE -------------------------------------------------------
  // buildMorphoSetupUserSide reads on-chain state and emits the XRPL
  // Payment only for whatever approvals are still missing; returns null
  // when nothing needs to be done.
  const userSide = await buildMorphoSetupUserSide({
    personalAccount,
    xrplClient,
    xrplWallet,
    amountXrp: memoOnlyAmountXrp,
  });

  if (userSide == null) {
    return;
  }

  // --- 2. EXECUTOR SIDE -------------------------------------------------
  const { receipt } = await executeDirectMintingWithData({
    xrplTransactionHash: userSide.xrplTransactionHash,
    data: userSide.data,
    value: userSide.totalCallValue,
    xrplClient,
    label: "morpho-setup",
  });

  // --- 3. CONFIRMATION --------------------------------------------------
  const event = findUserOperationExecuted(receipt, personalAccount, userSide.nonce);
  console.log("UserOperationExecuted:", event, "\n");

  await getAndLogState("After setup", personalAccount, marketDecimals);
}

void main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
