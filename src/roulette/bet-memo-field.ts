import { coston2 } from "@flarenetwork/flare-wagmi-periphery-package";
import { encodeFunctionData, parseEventLogs } from "viem";
import { Client, Wallet } from "xrpl";
import { abi as rouletteAbi } from "../abis/Roulette";
import { publicClient } from "../utils/client";
import { computeDirectMintingPaymentAmountXrp } from "../utils/fassets";
import { getPersonalAccountAddress, sendMemoFieldInstruction, type Call } from "../utils/smart-accounts";
import { rouletteAddress } from "./deploys";
import { formatFxrp, readChips, type RouletteContext } from "./utils";

// BetKind enum order in Roulette.sol: STRAIGHT, RED, BLACK, ODD, EVEN, LOW, HIGH
const BetKind = {
  STRAIGHT: 0,
  RED: 1,
  BLACK: 2,
  ODD: 3,
  EVEN: 4,
  LOW: 5,
  HIGH: 6,
} as const;

type BetKindValue = (typeof BetKind)[keyof typeof BetKind];

async function placeBet({
  context,
  bet,
  betAmount,
}: {
  context: RouletteContext;
  bet: { kind: BetKindValue; selection: number };
  betAmount: bigint;
}): Promise<{ betId: bigint; placedAt: bigint }> {
  const customInstruction: Call[] = [
    {
      target: rouletteAddress,
      value: 0n,
      data: encodeFunctionData({
        abi: rouletteAbi,
        functionName: "placeBet",
        args: [bet.kind, bet.selection, betAmount],
      }),
    },
  ];
  const submissionEvent = await sendMemoFieldInstruction({
    label: "place-bet",
    customInstruction,
    amountXrp: context.memoOnlyAmountXrp,
    personalAccount: context.personalAccount,
    xrplClient: context.xrplClient,
    xrplWallet: context.xrplWallet,
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash: submissionEvent.transactionHash! });
  const betPlacedLogs = parseEventLogs({ abi: rouletteAbi, eventName: "BetPlaced", logs: receipt.logs });
  const betPlacedLog = betPlacedLogs.find(
    (log) => log.args.player.toLowerCase() === context.personalAccount.toLowerCase()
  );
  if (!betPlacedLog) {
    throw new Error("BetPlaced event not found for our personal account");
  }
  const betId = betPlacedLog.args.betId;

  // Tuple order matches the `bets` getter outputs:
  // (player, kind, selection, amount, placedAt, settled).
  const [, , , , placedAt] = await publicClient.readContract({
    address: rouletteAddress,
    abi: rouletteAbi,
    functionName: "bets",
    args: [betId],
  });
  console.log("Bet placed — betId:", betId.toString(), "placedAt:", placedAt.toString(), "\n");
  return { betId, placedAt };
}

async function waitForNextSecureRandom(placedAt: bigint) {
  const generatorAddress = await publicClient.readContract({
    address: rouletteAddress,
    abi: rouletteAbi,
    functionName: "generator",
  });

  console.log("Polling for next secure random round…");
  while (true) {
    const [, isSecureRandom, randomTimestamp] = await publicClient.readContract({
      address: generatorAddress,
      abi: coston2.randomNumberV2InterfaceAbi,
      functionName: "getRandomNumber",
    });
    if (isSecureRandom && randomTimestamp > placedAt) {
      console.log("Random ready — randomTimestamp:", randomTimestamp.toString(), "\n");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 15_000));
  }
}

async function settleBet({ context, betId }: { context: RouletteContext; betId: bigint }) {
  const customInstruction: Call[] = [
    {
      target: rouletteAddress,
      value: 0n,
      data: encodeFunctionData({
        abi: rouletteAbi,
        functionName: "settleBet",
        args: [betId],
      }),
    },
  ];
  const submissionEvent = await sendMemoFieldInstruction({
    label: "settle-bet",
    customInstruction,
    amountXrp: context.memoOnlyAmountXrp,
    personalAccount: context.personalAccount,
    xrplClient: context.xrplClient,
    xrplWallet: context.xrplWallet,
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash: submissionEvent.transactionHash! });
  const betSettledLogs = parseEventLogs({ abi: rouletteAbi, eventName: "BetSettled", logs: receipt.logs });
  const betSettledLog = betSettledLogs.find((log) => log.args.betId === betId);
  if (!betSettledLog) {
    throw new Error("BetSettled event not found for this betId");
  }
  console.log(
    "Settled — wheel:",
    betSettledLog.args.wheel,
    "won:",
    betSettledLog.args.won,
    "payout:",
    formatFxrp(betSettledLog.args.payout),
    "FXRP\n"
  );
  return betSettledLog.args;
}

// NOTE:(Nik) Run src/roulette/fund-game-memo-field.ts first to mint FXRP and buy chips
// for the personal account. The contract owner must also have called
// `fundHouse` with enough FXRP to cover `betAmount * 35` (the worst-case
// straight-up payout) — even outside-bet plays are gated on the same
// solvency check via `outstandingMaxLoss`. Run src/roulette/cash-out-memo-field.ts
// afterwards to convert remaining chips back to FXRP. The Roulette address
// is read from ./deploys.ts.
async function main() {
  const betAmount = 1n * 10n ** 6n;
  const bet = { kind: BetKind.BLACK, selection: 0 };

  const xrplClient = new Client(process.env.XRPL_TESTNET_RPC_URL!);
  const xrplWallet = Wallet.fromSeed(process.env.XRPL_SEED!);

  const [personalAccount, memoOnlyAmountXrp] = await Promise.all([
    getPersonalAccountAddress(xrplWallet.address),
    computeDirectMintingPaymentAmountXrp({ netMintAmountXrp: 0 }),
  ]);
  console.log("Personal account address:", personalAccount, "\n");
  console.log("Memo-only amount (XRP, fees only):", memoOnlyAmountXrp, "\n");

  const context: RouletteContext = { personalAccount, memoOnlyAmountXrp, xrplClient, xrplWallet };

  const chipsBefore = await readChips(personalAccount);
  console.log("Chips before:", formatFxrp(chipsBefore), "FXRP\n");

  const { betId, placedAt } = await placeBet({ context, bet, betAmount });
  await waitForNextSecureRandom(placedAt);
  await settleBet({ context, betId });

  const chipsAfter = await readChips(personalAccount);
  console.log("Chips after:", formatFxrp(chipsAfter), "FXRP\n");
  console.log("P&L:", formatFxrp(chipsAfter - chipsBefore), "FXRP\n");
}

void main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
