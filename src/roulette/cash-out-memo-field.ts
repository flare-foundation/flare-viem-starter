import { encodeFunctionData, type Address } from "viem";
import { Client, Wallet } from "xrpl";
import { abi as rouletteAbi } from "../abis/Roulette";
import { computeDirectMintingPaymentAmountXrp, getFxrpBalance } from "../utils/fassets";
import { getPersonalAccountAddress, sendMemoFieldInstruction, type Call } from "../utils/smart-accounts";
import { rouletteAddress } from "./deploys";
import { formatFxrp, readChips, type RouletteContext } from "./utils";

async function readBalances(personalAccount: Address) {
  return Promise.all([readChips(personalAccount), getFxrpBalance(personalAccount)]);
}

async function cashOut({ context, chipAmount }: { context: RouletteContext; chipAmount: bigint }) {
  const calls: Call[] = [
    {
      target: rouletteAddress,
      value: 0n,
      data: encodeFunctionData({
        abi: rouletteAbi,
        functionName: "cashOut",
        args: [chipAmount],
      }),
    },
  ];
  await sendMemoFieldInstruction({
    label: "cash-out",
    calls,
    amountXrp: context.memoOnlyAmountXrp,
    personalAccount: context.personalAccount,
    xrplClient: context.xrplClient,
    xrplWallet: context.xrplWallet,
  });
}

// NOTE:(Nik) Cashes the personal account's full chip balance back into FXRP
// via Roulette.cashOut. Chips track raw FXRP units 1:1 (FXRP uses 6 decimals
// on Coston2), so the FXRP delta on the personal account equals the chip
// balance burned. The Roulette address is read from ./deploys.ts.
async function main() {
  const xrplClient = new Client(process.env.XRPL_TESTNET_RPC_URL!);
  const xrplWallet = Wallet.fromSeed(process.env.XRPL_SEED!);

  const [personalAccount, memoOnlyAmountXrp] = await Promise.all([
    getPersonalAccountAddress(xrplWallet.address),
    computeDirectMintingPaymentAmountXrp({ netMintAmountXrp: 0 }),
  ]);
  console.log("Personal account address:", personalAccount, "\n");
  console.log("Memo-only amount (XRP, fees only):", memoOnlyAmountXrp, "\n");

  const context: RouletteContext = { personalAccount, memoOnlyAmountXrp, xrplClient, xrplWallet };

  const [chipsBefore, fxrpBefore] = await readBalances(personalAccount);
  console.log("Chips before:", formatFxrp(chipsBefore), "FXRP\n");
  console.log("FXRP before:", formatFxrp(fxrpBefore), "FXRP\n");

  if (chipsBefore === 0n) {
    console.log("No chips to cash out. Exiting.");
    return;
  }

  await cashOut({ context, chipAmount: chipsBefore });

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
