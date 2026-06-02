import { encodeFunctionData } from "viem";
import { Client, Wallet } from "xrpl";
import { abi as MorphoMarketShimAbi } from "../abis/MorphoMarketShim";
import { getPersonalAccountAddress, sendMemoFieldInstruction } from "../utils/smart-accounts";
import { computeDirectMintingPaymentAmountXrp } from "../utils/fassets";
import { MORPHO_MARKET_SHIM_ADDRESS, fetchMarketDecimals, getAndLogState, marketId } from "./utils";

// NOTE:(Nik) Run after src/morpho/borrow-memo-field.ts has opened a position. Assumes
// src/morpho/setup-memo-field.ts has already funded the smart account and configured
// shim approvals + authorization on Morpho. Closes the smart account's
// Morpho position via the shim's `repayAndWithdrawCollateral` (share-
// denominated repay + withdraw, atomic) with the collateral routed back to
// the smart account. See borrow-memo-field.ts for architecture overview.
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
  console.log("Shim address:    ", MORPHO_MARKET_SHIM_ADDRESS, "\n");

  const { borrowShares, collateral } = await getAndLogState("Before repay", personalAccount, marketDecimals);

  if (borrowShares === 0n && collateral === 0n) {
    console.log("Nothing to repay or withdraw. Exiting.");
    return;
  }

  console.log("Repaying full position, borrowShares:", borrowShares.toString(), "\n");
  await sendMemoFieldInstruction({
    label: "repay-and-withdraw",
    customInstruction: [
      {
        target: MORPHO_MARKET_SHIM_ADDRESS,
        value: 0n,
        data: encodeFunctionData({
          abi: MorphoMarketShimAbi,
          functionName: "repayAndWithdrawCollateral",
          args: [borrowShares, collateral, personalAccount],
        }),
      },
    ],
    amountXrp: memoOnlyAmountXrp,
    personalAccount,
    xrplClient,
    xrplWallet,
  });

  await getAndLogState("After repay + withdraw", personalAccount, marketDecimals);
}

void main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
