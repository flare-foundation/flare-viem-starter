import { encodeFunctionData, type Address } from "viem";
import { Client, Wallet } from "xrpl";
import { abi as rouletteAbi } from "../abis/Roulette";
import { computeDirectMintingPaymentAmountXrp, getFxrpBalance } from "../utils/fassets";
import {
  executeDirectMintingWithData,
  findUserOperationExecuted,
  getPersonalAccountAddress,
  sendHashInstruction,
} from "../utils/smart-accounts";
import { rouletteAddress } from "./deploys";
import { formatFxrp, readChips } from "./utils";

async function readBalances(personalAccount: Address) {
  return Promise.all([readChips(personalAccount), getFxrpBalance(personalAccount)]);
}

// NOTE:(Nik) Cashes the personal account's full chip balance back into FXRP
// via Roulette.cashOut. Chips track raw FXRP units 1:1 (FXRP uses 6 decimals
// on Coston2), so the FXRP delta on the personal account equals the chip
// balance burned. The Roulette address is read from ./deploys.ts.
//
// 0xFE is a three-step protocol; this script runs all three steps inline.
async function main() {
  const xrplClient = new Client(process.env.XRPL_TESTNET_RPC_URL!);
  const xrplWallet = Wallet.fromSeed(process.env.XRPL_SEED!);

  const [personalAccount, memoOnlyAmountXrp] = await Promise.all([
    getPersonalAccountAddress(xrplWallet.address),
    computeDirectMintingPaymentAmountXrp({ netMintAmountXrp: 0 }),
  ]);
  console.log("Personal account address:", personalAccount, "\n");
  console.log("Memo-only amount (XRP, fees only):", memoOnlyAmountXrp, "\n");

  const [chipsBefore, fxrpBefore] = await readBalances(personalAccount);
  console.log("Chips before:", formatFxrp(chipsBefore), "FXRP\n");
  console.log("FXRP before:", formatFxrp(fxrpBefore), "FXRP\n");

  if (chipsBefore === 0n) {
    console.log("No chips to cash out. Exiting.");
    return;
  }

  // --- 1. USER SIDE -------------------------------------------------------
  const userSide = await sendHashInstruction({
    label: "cash-out",
    customInstruction: [
      {
        target: rouletteAddress,
        value: 0n,
        data: encodeFunctionData({
          abi: rouletteAbi,
          functionName: "cashOut",
          args: [chipsBefore],
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
    label: "cash-out",
  });

  // --- 3. CONFIRMATION ----------------------------------------------------
  const event = findUserOperationExecuted(receipt, personalAccount, userSide.nonce);
  console.log("UserOperationExecuted:", event, "\n");

  const [chipsAfter, fxrpAfter] = await readBalances(personalAccount);
  console.log("Chips after:", formatFxrp(chipsAfter), "FXRP\n");
  console.log("FXRP after:", formatFxrp(fxrpAfter), "FXRP\n");
  console.log("FXRP cashed out:", formatFxrp(fxrpAfter - fxrpBefore), "FXRP\n");
}

void main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
