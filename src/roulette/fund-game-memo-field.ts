import { encodeFunctionData, type Address } from "viem";
import { Client, Wallet } from "xrpl";
import { abi as erc20Abi } from "../abis/ERC20";
import { abi as rouletteAbi } from "../abis/Roulette";
import { computeDirectMintingPaymentAmountXrp } from "../utils/fassets";
import { getFxrpAddress } from "../utils/flare-contract-registry";
import { getPersonalAccountAddress, sendMemoFieldInstruction, type Call } from "../utils/smart-accounts";
import { rouletteAddress } from "./deploys";
import { formatFxrp, readChips, type RouletteContext } from "./utils";

async function mintFxrpAndApprove({
  context,
  fxrpAddress,
  approveAmount,
  paymentAmountXrp,
}: {
  context: RouletteContext;
  fxrpAddress: Address;
  approveAmount: bigint;
  paymentAmountXrp: number;
}) {
  const calls: Call[] = [
    {
      target: fxrpAddress,
      value: 0n,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [rouletteAddress, approveAmount],
      }),
    },
  ];
  await sendMemoFieldInstruction({
    label: "mint-and-approve",
    calls,
    amountXrp: paymentAmountXrp,
    personalAccount: context.personalAccount,
    xrplClient: context.xrplClient,
    xrplWallet: context.xrplWallet,
  });
}

async function buyChips({ context, chipAmount }: { context: RouletteContext; chipAmount: bigint }) {
  const calls: Call[] = [
    {
      target: rouletteAddress,
      value: 0n,
      data: encodeFunctionData({
        abi: rouletteAbi,
        functionName: "buyChips",
        args: [chipAmount],
      }),
    },
  ];
  await sendMemoFieldInstruction({
    label: "buy-chips",
    calls,
    amountXrp: context.memoOnlyAmountXrp,
    personalAccount: context.personalAccount,
    xrplClient: context.xrplClient,
    xrplWallet: context.xrplWallet,
  });
}

// NOTE:(Nik) For this example to work, you first need to faucet C2FLR to your
// personal account address. We can't fit FXRP `approve` + Roulette `buyChips`
// in a single XRPL memo (two ABI-encoded calls plus the user-op envelope
// overflow the ~1024-byte cap), so we use two payments:
//   1. Mint FXRP into the personal account and run `approve(roulette, …)` —
//      one call, fits comfortably.
//   2. A memo-only follow-up that calls `buyChips`.
// The Roulette address is read from ./deploys.ts — redeploy via
// `yarn hardhat run scripts/roulette/deploy.ts --network coston2` in
// flare-hardhat-starter and update the address there.
async function main() {
  // Mint 10 XRP into 10 FXRP and immediately convert all of it into chips.
  // FXRP uses 6 decimals on Coston2 (mirroring XRP drops); chips track raw
  // FXRP units 1:1, so 10 FXRP → 10 * 1e6 chips.
  const fxrpMintAmount = 10;
  const chipAmount = 10n * 10n ** 6n;

  const xrplClient = new Client(process.env.XRPL_TESTNET_RPC_URL!);
  const xrplWallet = Wallet.fromSeed(process.env.XRPL_SEED!);

  const [personalAccount, fxrpAddress, paymentAmountXrp, memoOnlyAmountXrp] = await Promise.all([
    getPersonalAccountAddress(xrplWallet.address),
    getFxrpAddress(),
    computeDirectMintingPaymentAmountXrp({ netMintAmountXrp: fxrpMintAmount }),
    computeDirectMintingPaymentAmountXrp({ netMintAmountXrp: 0 }),
  ]);
  console.log("Personal account address:", personalAccount, "\n");
  console.log("FXRP address:", fxrpAddress, "\n");
  console.log("Payment amount (XRP, net mint + fees):", paymentAmountXrp, "\n");
  console.log("Memo-only amount (XRP, fees only):", memoOnlyAmountXrp, "\n");

  const context: RouletteContext = { personalAccount, memoOnlyAmountXrp, xrplClient, xrplWallet };

  const chipsBefore = await readChips(personalAccount);
  console.log("Chips before:", formatFxrp(chipsBefore), "FXRP\n");

  await mintFxrpAndApprove({ context, fxrpAddress, approveAmount: chipAmount, paymentAmountXrp });
  await buyChips({ context, chipAmount });

  const chipsAfter = await readChips(personalAccount);
  console.log("Chips after:", formatFxrp(chipsAfter), "FXRP\n");
  console.log("Chips bought:", formatFxrp(chipsAfter - chipsBefore), "FXRP\n");
}

void main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
