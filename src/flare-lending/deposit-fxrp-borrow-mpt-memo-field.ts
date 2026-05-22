import { encodeFunctionData } from "viem";
import { Client, Wallet } from "xrpl";
import { MPT_ISSUANCE_ID } from "./config";
import { abi as BridgeAbi } from "../abis/DummyBridge";
import { abi as LendingAbi } from "../abis/DummyLending";
import { abi as ERC20Abi } from "../abis/ERC20";
import { getPersonalAccountAddress, sendMemoFieldInstruction, type Call } from "../utils/smart-accounts";
import { computeDirectMintingPaymentAmountXrp } from "../utils/fassets";
import { findLatestInitiateBridgeEventInLast30Blocks, transferEventAmountMptToXrplAddress } from "./utils";

// NOTE:(Nik) For this example to work, you first need to faucet C2FLR to your personal account address.
async function main() {
  // Net FXRP amount to mint in XRP. Minting + executor fees are fetched from
  // AssetManagerFXRP and added on top to form the XRPL payment amount.
  const fxrpMintAmount = 10;

  const xrplClient = new Client(process.env.XRPL_TESTNET_RPC_URL!);
  const xrplWallet = Wallet.fromSeed(process.env.XRPL_SEED!);
  const vaultWallet = Wallet.fromSeed(process.env.VAULT_SEED!);

  const loanContractAddress = "0xa5B3E70376B6CdbBfD33bd2af656f3Fada8f017f";
  const dummyUSDTAddress = "0x8A6a67b3edf7A876E107090485681ec71cAdf3bA";
  const bridgeAddress = "0x620864B25471EFEbBd27bFc3239AEB1888fc35b9";

  const FXRPAddress = "0x0b6A3645c240605887a5532109323A3E12273dc7";

  const amountToDeposit = 100;
  const amountToBorrow = 10n;

  // XRPL caps each memo at ~1024 bytes. The `approve` and `initiateBridge`
  // encodings are large enough that no 2-call combination fits except
  // `[depositCollateral, takeLoan]`, so the 5 calls split into 4 batches.
  const approveFxrpCalls: Call[] = [
    {
      target: FXRPAddress,
      value: BigInt(0),
      data: encodeFunctionData({
        abi: ERC20Abi,
        functionName: "approve",
        args: [loanContractAddress, amountToDeposit],
      }),
    },
  ];
  const approveUsdtCalls: Call[] = [
    {
      target: dummyUSDTAddress,
      value: BigInt(0),
      data: encodeFunctionData({
        abi: ERC20Abi,
        functionName: "approve",
        args: [bridgeAddress, amountToBorrow],
      }),
    },
  ];
  const depositAndBorrowCalls: Call[] = [
    {
      target: loanContractAddress,
      value: BigInt(0),
      data: encodeFunctionData({
        abi: LendingAbi,
        functionName: "depositCollateral",
        args: [amountToDeposit],
      }),
    },
    {
      target: loanContractAddress,
      value: BigInt(0),
      data: encodeFunctionData({
        abi: LendingAbi,
        functionName: "takeLoan",
        args: [amountToBorrow],
      }),
    },
  ];
  const bridgeCalls: Call[] = [
    {
      target: bridgeAddress,
      value: BigInt(0),
      data: encodeFunctionData({
        abi: BridgeAbi,
        functionName: "initiateBridge",
        args: [xrplWallet.address, amountToBorrow],
      }),
    },
  ];

  const [personalAccount, paymentAmountXrp, memoOnlyAmountXrp] = await Promise.all([
    getPersonalAccountAddress(xrplWallet.address),
    computeDirectMintingPaymentAmountXrp({ netMintAmountXrp: fxrpMintAmount }),
    computeDirectMintingPaymentAmountXrp({ netMintAmountXrp: 0 }),
  ]);
  console.log("Personal account address:", personalAccount, "\n");
  console.log("Payment amount (XRP, net mint + fees):", paymentAmountXrp, "\n");
  console.log("Memo-only amount (XRP, fees only):", memoOnlyAmountXrp, "\n");

  await sendMemoFieldInstruction({
    label: "approve-fxrp",
    calls: approveFxrpCalls,
    amountXrp: paymentAmountXrp,
    personalAccount,
    xrplClient,
    xrplWallet,
  });

  await sendMemoFieldInstruction({
    label: "deposit-and-borrow",
    calls: depositAndBorrowCalls,
    amountXrp: memoOnlyAmountXrp,
    personalAccount,
    xrplClient,
    xrplWallet,
  });

  await sendMemoFieldInstruction({
    label: "approve-usdt",
    calls: approveUsdtCalls,
    amountXrp: memoOnlyAmountXrp,
    personalAccount,
    xrplClient,
    xrplWallet,
  });

  await sendMemoFieldInstruction({
    label: "bridge",
    calls: bridgeCalls,
    amountXrp: memoOnlyAmountXrp,
    personalAccount,
    xrplClient,
    xrplWallet,
  });

  const initiateBridgeEvent = await findLatestInitiateBridgeEventInLast30Blocks({
    bridgeAddress: bridgeAddress as `0x${string}`,
    personalAccountAddress: personalAccount,
  });
  console.log("InitiateBridge event:", initiateBridgeEvent, "\n");

  await transferEventAmountMptToXrplAddress({
    initiateBridgeEvent,
    xrplClient,
    vaultWallet,
    mptIssuanceId: MPT_ISSUANCE_ID,
    assetScale: 6,
    recipientXrplWallet: xrplWallet,
  });
}

void main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
