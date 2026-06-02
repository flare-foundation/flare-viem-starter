import { encodeFunctionData } from "viem";
import { Client, Wallet } from "xrpl";
import { abi as erc20Abi } from "../abis/ERC20";
import { abi as rouletteAbi } from "../abis/Roulette";
import { computeDirectMintingPaymentAmountXrp } from "../utils/fassets";
import { getFxrpAddress } from "../utils/flare-contract-registry";
import {
  executeDirectMintingWithData,
  findUserOperationExecuted,
  getPersonalAccountAddress,
  sendHashInstruction,
  type Call,
} from "../utils/smart-accounts";
import { rouletteAddress } from "./deploys";
import { formatFxrp, readChips } from "./utils";

// NOTE:(Nik) For this example to work, you first need to faucet C2FLR to your
// personal account address. With 0xFE the XRPL memo is a constant 42 bytes,
// so the FXRP `approve` and Roulette `buyChips` calls that the 0xFF flow
// split across two payments fit into a single batch here. The XRPL payment
// also carries the FXRP mint amount so the personal account receives FXRP
// before `buyChips` runs (calls within a single user op execute atomically
// after the AssetManager has already credited FXRP).
//
// 0xFE is a three-step protocol; this script runs all three steps inline.
//
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

  const [personalAccount, fxrpAddress, paymentAmountXrp] = await Promise.all([
    getPersonalAccountAddress(xrplWallet.address),
    getFxrpAddress(),
    computeDirectMintingPaymentAmountXrp({ netMintAmountXrp: fxrpMintAmount }),
  ]);
  console.log("Personal account address:", personalAccount, "\n");
  console.log("FXRP address:", fxrpAddress, "\n");
  console.log("Payment amount (XRP, net mint + fees):", paymentAmountXrp, "\n");

  const chipsBefore = await readChips(personalAccount);
  console.log("Chips before:", formatFxrp(chipsBefore), "FXRP\n");

  const customInstruction: Call[] = [
    {
      target: fxrpAddress,
      value: 0n,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [rouletteAddress, chipAmount],
      }),
    },
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

  // --- 1. USER SIDE -------------------------------------------------------
  const userSide = await sendHashInstruction({
    label: "mint-approve-and-buy-chips",
    customInstruction,
    amountXrp: paymentAmountXrp,
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
    label: "mint-approve-and-buy-chips",
  });

  // --- 3. CONFIRMATION ----------------------------------------------------
  const event = findUserOperationExecuted(receipt, personalAccount, userSide.nonce);
  console.log("UserOperationExecuted:", event, "\n");

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
