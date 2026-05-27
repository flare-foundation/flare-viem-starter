import { encodeFunctionData, type Address } from "viem";
import { Client, Wallet } from "xrpl";
import { MPT_ISSUANCE_ID } from "./config";
import { abi as BridgeAbi } from "../abis/DummyBridge";
import { abi as LendingAbi } from "../abis/DummyCertifiedLending";
import { abi as ERC20Abi } from "../abis/ERC20";
import { account, publicClient, walletClient } from "../utils/client";
import {
  prepareAttestationRequest,
  retrieveDataAndProofWithRetry,
  submitAttestationRequest,
  type Web2JsonProof,
} from "../utils/fdc";
import { getPersonalAccountAddress, sendMemoFieldInstruction, type Call } from "../utils/smart-accounts";
import { computeDirectMintingPaymentAmountXrp } from "../utils/fassets";
import { findLatestInitiateBridgeEventInLast30Blocks, transferEventAmountMptToXrplAddress } from "./utils";

async function prepareRequestBody(
  subjectXrplAddress: string,
  dummyLendingAddress: `0x${string}`,
  xrplJsonRpcUrl = "https://testnet.xrpl-labs.com/"
): Promise<{
  url: string;
  httpMethod: "POST";
  headers: string;
  queryParams: string;
  body: string;
  postProcessJq: string;
  abiSignature: string;
}> {
  const [expectedCredentialType, expectedIssuer] = (await Promise.all([
    publicClient.readContract({
      address: dummyLendingAddress,
      abi: LendingAbi,
      functionName: "CREDENTIAL_TYPE",
      args: [],
    }),
    publicClient.readContract({
      address: dummyLendingAddress,
      abi: LendingAbi,
      functionName: "CREDENTIAL_ISSUER",
      args: [],
    }),
  ])) as [string, string];
  const escapeForJq = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  // Verifier disallows jq's error(); use empty when no match so the filter is accepted (encoding will then fail).
  const postProcessJq = `.result | . as $res | ($res | .account_objects[]? | select(.CredentialType == "${escapeForJq(expectedCredentialType)}" and .Issuer == "${escapeForJq(expectedIssuer)}")) as $obj | if $obj then {account: $res.account, credentialType: $obj.CredentialType, issuer: $obj.Issuer} else {account: $res.account, credentialType: "", issuer: ""} end`;

  // ABI signature must match the struct used to decode the jq output (DataTransportObject).
  // Derived from DummyCertifiedLending.abiSignatureHack(DataTransportObject) so it stays in sync.
  const abiSignatureHack = LendingAbi.find((f) => f.type === "function" && f.name === "abiSignatureHack");
  const dtoInput = (abiSignatureHack && "inputs" in abiSignatureHack && abiSignatureHack.inputs?.[0]) ?? null;
  if (!dtoInput || typeof dtoInput !== "object") {
    throw new Error("DummyCertifiedLending ABI missing abiSignatureHack(DataTransportObject) input type");
  }
  const abiSignature = JSON.stringify(dtoInput);
  return {
    url: xrplJsonRpcUrl,
    httpMethod: "POST" as const,
    headers: JSON.stringify({ "Content-Type": "application/json" }),
    queryParams: JSON.stringify({}),
    body: JSON.stringify({
      method: "account_objects",
      params: [
        {
          account: subjectXrplAddress,
          type: "credential",
          ledger_index: "validated",
        },
      ],
    }),
    postProcessJq,
    abiSignature,
  };
}

async function getCertificateFdcProof(xrplWallet: Wallet, dummyLendingAddress: `0x${string}`): Promise<Web2JsonProof> {
  const attestationType = "Web2Json";
  const sourceId = "PublicWeb2";
  const fdcCredentialCheckRequestBody = await prepareRequestBody(xrplWallet.address, dummyLendingAddress);

  const verifierBaseUrl = process.env.VERIFIER_URL_TESTNET!;
  const apiKey = process.env.VERIFIER_API_KEY_TESTNET;

  const verifierUrl = `${verifierBaseUrl.replace(/\/$/, "")}/verifier/web2/Web2Json/prepareRequest`;
  if (!verifierUrl || !apiKey) {
    throw new Error(
      "FDC verifier config missing: set VERIFIER_URL_TESTNET (or WEB2JSON_VERIFIER_URL_TESTNET) and VERIFIER_API_KEY_TESTNET"
    );
  }

  const { abiEncodedRequest } = await prepareAttestationRequest(
    verifierUrl,
    apiKey,
    attestationType,
    sourceId,
    fdcCredentialCheckRequestBody as Record<string, unknown>
  );
  console.log("Abi encoded request:", abiEncodedRequest, "\n");

  const roundId = await submitAttestationRequest(abiEncodedRequest as `0x${string}`);

  const web2JsonProof = await retrieveDataAndProofWithRetry(abiEncodedRequest, roundId);
  console.log("Web2Json proof:", web2JsonProof, "\n");

  return web2JsonProof;
}

/**
 * Ensures the XRPL user is validated on DummyLending. If validUser(personalAccount) is false,
 * fetches the certificate FDC proof and calls validateUser(proof) on the DummyLending contract.
 */
async function validateUser(
  xrplWallet: Wallet,
  personalAccount: Address,
  dummyLendingAddress: `0x${string}`
): Promise<void> {
  const isAlreadyValid = await publicClient.readContract({
    address: dummyLendingAddress,
    abi: LendingAbi,
    functionName: "validUser",
    args: [personalAccount],
  });
  if (isAlreadyValid) {
    console.log("User already validated on DummyLending, skipping validateUser tx.\n");
    return;
  }
  console.log("Validating user on DummyLending...");
  const certificateFdcProof = await getCertificateFdcProof(xrplWallet, dummyLendingAddress);
  const hash = await walletClient.writeContract({
    account,
    address: dummyLendingAddress,
    abi: LendingAbi,
    functionName: "validateUser",
    args: [certificateFdcProof],
  });
  console.log("validateUser transaction hash:", hash, "\n");
  await publicClient.waitForTransactionReceipt({ hash });
}

// NOTE:(Nik) For this example to work, you first need to faucet C2FLR to your personal account address.
async function main() {
  // Net FXRP amount to mint in XRP. Minting + executor fees are fetched from
  // AssetManagerFXRP and added on top to form the XRPL payment amount.
  const fxrpMintAmount = 10;

  const xrplClient = new Client(process.env.XRPL_TESTNET_RPC_URL!);
  const xrplWallet = Wallet.fromSeed(process.env.XRPL_SEED!);
  const vaultWallet = Wallet.fromSeed(process.env.VAULT_SEED!);

  const dummyERC20Address = "0xF395C367fEfb7239C4f7fC5C3DF30d719A43A734";
  const dummyLendingAddress = "0xb5627a19Be042015B985431Da98b567e79F14eE0" as `0x${string}`;
  const dummyBridgeAddress = "0x33D4889324aeC935397E853E933DD5Cc836410be";

  const FXRPAddress = "0x0b6A3645c240605887a5532109323A3E12273dc7";

  const amountToDeposit = 100;
  const amountToBorrow = 10n;

  const personalAccount = await getPersonalAccountAddress(xrplWallet.address);
  console.log("Personal account address:", personalAccount, "\n");

  await validateUser(xrplWallet, personalAccount, dummyLendingAddress);

  const [paymentAmountXrp, memoOnlyAmountXrp] = await Promise.all([
    computeDirectMintingPaymentAmountXrp({ netMintAmountXrp: fxrpMintAmount }),
    computeDirectMintingPaymentAmountXrp({ netMintAmountXrp: 0 }),
  ]);
  console.log("Payment amount (XRP, net mint + fees):", paymentAmountXrp, "\n");
  console.log("Memo-only amount (XRP, fees only):", memoOnlyAmountXrp, "\n");

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
        args: [dummyLendingAddress, amountToDeposit],
      }),
    },
  ];
  const depositAndBorrowCalls: Call[] = [
    {
      target: dummyLendingAddress,
      value: BigInt(0),
      data: encodeFunctionData({
        abi: LendingAbi,
        functionName: "depositCollateral",
        args: [amountToDeposit],
      }),
    },
    {
      target: dummyLendingAddress,
      value: BigInt(0),
      data: encodeFunctionData({
        abi: LendingAbi,
        functionName: "takeLoan",
        args: [amountToBorrow],
      }),
    },
  ];
  const approveUsdtCalls: Call[] = [
    {
      target: dummyERC20Address,
      value: BigInt(0),
      data: encodeFunctionData({
        abi: ERC20Abi,
        functionName: "approve",
        args: [dummyBridgeAddress, amountToBorrow],
      }),
    },
  ];
  const bridgeCalls: Call[] = [
    {
      target: dummyBridgeAddress,
      value: BigInt(0),
      data: encodeFunctionData({
        abi: BridgeAbi,
        functionName: "initiateBridge",
        args: [xrplWallet.address, amountToBorrow],
      }),
    },
  ];

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
    bridgeAddress: dummyBridgeAddress as `0x${string}`,
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
