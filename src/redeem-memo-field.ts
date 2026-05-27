import { encodeFunctionData, zeroAddress } from "viem";
import { Client, Wallet } from "xrpl";
import { coston2 } from "@flarenetwork/flare-wagmi-periphery-package";
import { getPersonalAccountAddress, sendMemoFieldInstruction, type Call } from "./utils/smart-accounts";
import { getContractAddressByName } from "./utils/flare-contract-registry";
import { computeDirectMintingPaymentAmountXrp } from "./utils/fassets";

const LOTS_TO_REDEEM = 1n;

async function main() {
  // Net FXRP amount to mint in XRP. Minting + executor fees are fetched from
  // AssetManagerFXRP and added on top to form the XRPL payment amount.
  const fxrpMintAmount = 10;

  const xrplClient = new Client(process.env.XRPL_TESTNET_RPC_URL!);
  const xrplWallet = Wallet.fromSeed(process.env.XRPL_SEED!);

  const [personalAccount, assetManagerFXRPAddress] = await Promise.all([
    getPersonalAccountAddress(xrplWallet.address),
    getContractAddressByName("AssetManagerFXRP"),
  ]);
  console.log("Personal account address:", personalAccount, "\n");

  const redeemCalls: Call[] = [
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

  const paymentAmountXrp = await computeDirectMintingPaymentAmountXrp({
    netMintAmountXrp: fxrpMintAmount,
  });
  console.log("Payment amount (XRP, net mint + fees):", paymentAmountXrp, "\n");

  await sendMemoFieldInstruction({
    label: "redeem",
    calls: redeemCalls,
    amountXrp: paymentAmountXrp,
    personalAccount,
    xrplClient,
    xrplWallet,
  });
}

void main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
