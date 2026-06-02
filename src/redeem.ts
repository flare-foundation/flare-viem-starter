import { encodeFunctionData, zeroAddress } from "viem";
import { Client, Wallet } from "xrpl";
import { coston2 } from "@flarenetwork/flare-wagmi-periphery-package";
import {
  executeDirectMintingWithData,
  findUserOperationExecuted,
  getPersonalAccountAddress,
  sendHashInstruction,
  type Call,
} from "./utils/smart-accounts";
import { getContractAddressByName } from "./utils/flare-contract-registry";
import { computeDirectMintingPaymentAmountXrp } from "./utils/fassets";

const LOTS_TO_REDEEM = 1n;

// NOTE:(Nik) The XRPL payment carries only `keccak256(userOp)` (42-byte
// memo), so the redeem call payload travels off-chain to the executor.
//
// 0xFE is a three-step protocol; this script runs all three steps inline.
// In production the user side and executor side are separate actors.
async function main() {
  // Net FXRP amount to mint in XRP. Minting + executor fees are fetched from
  // AssetManagerFXRP and added on top to form the XRPL payment amount.
  const fxrpMintAmount = 10;

  const xrplClient = new Client(process.env.XRPL_TESTNET_RPC_URL!);
  const xrplWallet = Wallet.fromSeed(process.env.XRPL_SEED!);

  const [personalAccount, assetManagerFXRPAddress, paymentAmountXrp] = await Promise.all([
    getPersonalAccountAddress(xrplWallet.address),
    getContractAddressByName("AssetManagerFXRP"),
    computeDirectMintingPaymentAmountXrp({ netMintAmountXrp: fxrpMintAmount }),
  ]);
  console.log("Personal account address:", personalAccount, "\n");
  console.log("Payment amount (XRP, net mint + fees):", paymentAmountXrp, "\n");

  const redeemCustomInstruction: Call[] = [
    {
      target: assetManagerFXRPAddress,
      value: 0n,
      data: encodeFunctionData({
        abi: coston2.iAssetManagerAbi,
        functionName: "redeem",
        args: [LOTS_TO_REDEEM, xrplWallet.address, zeroAddress],
      }),
    },
  ];

  // --- 1. USER SIDE -------------------------------------------------------
  const userSide = await sendHashInstruction({
    label: "redeem",
    customInstruction: redeemCustomInstruction,
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
    label: "redeem",
  });

  // --- 3. CONFIRMATION ----------------------------------------------------
  const event = findUserOperationExecuted(receipt, personalAccount, userSide.nonce);
  console.log("UserOperationExecuted:", event, "\n");
}

void main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
