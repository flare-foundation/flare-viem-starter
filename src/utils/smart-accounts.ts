import {
  encodeAbiParameters,
  encodeFunctionData,
  fromHex,
  keccak256,
  parseEventLogs,
  type Address,
  type TransactionReceipt,
} from "viem";
import { MemoFieldUserOpCustomInstruction, UserOpCustomInstruction } from "@flarenetwork/smart-accounts-encoder";
import { Client, dropsToXrp, Wallet } from "xrpl";
import { coston2 } from "@flarenetwork/flare-wagmi-periphery-package";
import { account, publicClient, walletClient } from "./client";
import { sendXrplPayment, waitForXrplFinality, XRPL_FDC_CONFIRMATIONS } from "./xrpl";
import { getAssetManagerFXRPAddress, getMasterAccountControllerAddress } from "./flare-contract-registry";
import { abi as iMemoInstructionsFacetAbi } from "../abis/IMemoInstructionsFacet";
import { abi as iDirectMintingExtAbi } from "../abis/IDirectMintingExt";
import {
  prepareXrpPaymentRequest,
  retrieveXrpPaymentProofWithRetry,
  submitAttestationRequest,
  type IXrpPaymentProof,
} from "./fdc";
import type { UserOperationExecutedEventType } from "./event-types";

export async function getInstructionFee(encodedInstruction: string): Promise<number> {
  const instructionId = encodedInstruction.slice(0, 4);
  const instructionIdDecimal = fromHex(instructionId as `0x${string}`, "bigint");

  const requestFee = await publicClient.readContract({
    address: await getMasterAccountControllerAddress(),
    abi: coston2.iMasterAccountControllerAbi,
    functionName: "getInstructionFee",
    args: [instructionIdDecimal],
  });
  return dropsToXrp(Number(requestFee));
}

export async function getOperatorXrplAddresses() {
  const result = await publicClient.readContract({
    address: await getMasterAccountControllerAddress(),
    abi: coston2.iMasterAccountControllerAbi,
    functionName: "getXrplProviderWallets",
    args: [],
  });
  return result as string[];
}

export async function getPersonalAccountAddress(xrplAddress: string) {
  const personalAccountAddress = await publicClient.readContract({
    address: await getMasterAccountControllerAddress(),
    abi: coston2.iMasterAccountControllerAbi,
    functionName: "getPersonalAccount",
    args: [xrplAddress],
  });

  return personalAccountAddress;
}

export async function getXrplAccountForAddress(evmAddress: Address): Promise<`0x${string}`> {
  const xrplOwner = await publicClient.readContract({
    address: evmAddress,
    abi: coston2.iPersonalAccountAbi,
    functionName: "xrplOwner",
    args: [],
  });
  return xrplOwner && xrplOwner.length > 0 ? evmAddress : "0x0000000000000000000000000000000000000000";
}

export async function isSmartAccount(evmAddress: Address): Promise<boolean> {
  const smartAccountAddress = await getXrplAccountForAddress(evmAddress);
  return smartAccountAddress !== "0x0000000000000000000000000000000000000000";
}

export type Vault = {
  id: bigint;
  address: Address;
  type: number;
};

export type GetVaultsReturnType = [bigint[], string[], number[]];

export async function getVaults(): Promise<Vault[]> {
  const _vaults = (await publicClient.readContract({
    address: await getMasterAccountControllerAddress(),
    abi: coston2.iMasterAccountControllerAbi,
    functionName: "getVaults",
    args: [],
  })) as GetVaultsReturnType;

  const length = _vaults[0].length;
  if (length === 0) {
    return [];
  }

  const vaults = new Array(length) as Vault[];

  _vaults[0].forEach((id, index) => {
    vaults[index] = {
      id,
      address: _vaults[1][index]! as Address,
      type: _vaults[2][index]!,
    };
  });

  return vaults;
}

export type AgentVault = {
  id: bigint;
  address: Address;
};

export type GetAgentVaultsReturnType = [bigint[], string[]];

export async function getAgentVaults(): Promise<AgentVault[]> {
  const _vaults = await publicClient.readContract({
    address: await getMasterAccountControllerAddress(),
    abi: coston2.iMasterAccountControllerAbi,
    functionName: "getAgentVaults",
    args: [],
  });

  const length = _vaults[0].length;
  if (length === 0) {
    return [];
  }

  const vaults = new Array(length) as AgentVault[];

  _vaults[0].forEach((id, index) => {
    vaults[index] = {
      id,
      address: _vaults[1][index]!,
    };
  });

  return vaults;
}

export type Call = {
  target: Address;
  value: bigint;
  data: `0x${string}`;
};

const ZERO_BYTES32 = ("0x" + "00".repeat(32)) as `0x${string}`;

const PACKED_USER_OPERATION_TUPLE = {
  type: "tuple",
  components: [
    { name: "sender", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "initCode", type: "bytes" },
    { name: "callData", type: "bytes" },
    { name: "accountGasLimits", type: "bytes32" },
    { name: "preVerificationGas", type: "uint256" },
    { name: "gasFees", type: "bytes32" },
    { name: "paymasterAndData", type: "bytes" },
    { name: "signature", type: "bytes" },
  ],
} as const;

export async function getNonce(personalAccount: Address): Promise<bigint> {
  return publicClient.readContract({
    address: await getMasterAccountControllerAddress(),
    abi: iMemoInstructionsFacetAbi,
    functionName: "getNonce",
    args: [personalAccount],
  }) as Promise<bigint>;
}

export async function getDirectMintingPaymentAddress(): Promise<string> {
  const assetManagerAddress = await getAssetManagerFXRPAddress();
  return publicClient.readContract({
    address: assetManagerAddress,
    abi: coston2.iDirectMintingAbi,
    functionName: "directMintingPaymentAddress",
  });
}

export async function getMintingTagManagerAddress(): Promise<Address> {
  const assetManagerAddress = await getAssetManagerFXRPAddress();
  return publicClient.readContract({
    address: assetManagerAddress,
    abi: coston2.iDirectMintingSettingsAbi,
    functionName: "getMintingTagManager",
  });
}

function encodePackedUserOpData({
  customInstruction,
  sender,
  nonce,
}: {
  customInstruction: Call[];
  sender: Address;
  nonce: bigint;
}): `0x${string}` {
  const callData = encodeFunctionData({
    abi: coston2.iPersonalAccountAbi,
    functionName: "executeUserOp",
    args: [customInstruction],
  });

  return encodeAbiParameters(
    [PACKED_USER_OPERATION_TUPLE],
    [
      {
        sender,
        nonce,
        initCode: "0x",
        callData,
        accountGasLimits: ZERO_BYTES32,
        preVerificationGas: 0n,
        gasFees: ZERO_BYTES32,
        paymasterAndData: "0x",
        signature: "0x",
      },
    ]
  );
}

// Opcode 0xFF: the full ABI-encoded PackedUserOperation rides inside the memo,
// after the 10-byte header. The encoder owns the byte layout
// [0xFF | walletId(1B) | executorFeeUBA(8B) | packedUserOperation].
export function encodeExecuteUserOpMemo({
  customInstruction,
  walletId,
  executorFeeUBA,
  sender,
  nonce,
}: {
  customInstruction: Call[];
  walletId: number;
  executorFeeUBA: bigint;
  sender: Address;
  nonce: bigint;
}): `0x${string}` {
  const packedUserOperation = encodePackedUserOpData({ customInstruction, sender, nonce });
  return new MemoFieldUserOpCustomInstruction({ walletId, executorFeeUBA, packedUserOperation }).encode();
}

// Opcode 0xFE: the memo carries only the 32-byte hash after the 10-byte header
// (42 bytes total). The full PackedUserOperation lives in `data`; the executor
// passes it as the `_data` argument to AssetManagerFXRP.handleMintedFAssets, and
// the on-chain facet verifies that keccak256(_data) matches the hash before executing.
export function encodeHashInstructionMemo({
  customInstruction,
  walletId,
  executorFeeUBA,
  sender,
  nonce,
}: {
  customInstruction: Call[];
  walletId: number;
  executorFeeUBA: bigint;
  sender: Address;
  nonce: bigint;
}): { memoData: `0x${string}`; data: `0x${string}` } {
  const data = encodePackedUserOpData({ customInstruction, sender, nonce });
  const memoData = new UserOpCustomInstruction({
    walletId,
    executorFeeUBA,
    userOperationHash: keccak256(data),
  }).encode();
  return { memoData, data };
}

export async function sendMemoFieldInstruction({
  label,
  customInstruction,
  amountXrp,
  personalAccount,
  xrplClient,
  xrplWallet,
}: {
  label: string;
  customInstruction: Call[];
  amountXrp: number;
  personalAccount: Address;
  xrplClient: Client;
  xrplWallet: Wallet;
}) {
  console.log(`[${label}] customInstruction:`, customInstruction, "\n");

  const [nonce, coreVaultXrplAddress] = await Promise.all([
    getNonce(personalAccount),
    getDirectMintingPaymentAddress(),
  ]);
  console.log(`[${label}] current nonce:`, nonce, "\n");

  const memoData = encodeExecuteUserOpMemo({
    customInstruction,
    walletId: 0,
    executorFeeUBA: 0n,
    sender: personalAccount,
    nonce,
  });

  const transaction = await sendXrplPayment({
    destination: coreVaultXrplAddress,
    amount: amountXrp,
    memos: [{ Memo: { MemoData: memoData.slice(2) } }],
    wallet: xrplWallet,
    client: xrplClient,
  });
  console.log(`[${label}] XRPL transaction hash:`, transaction.result.hash, "\n");

  const event = await waitForUserOperationExecuted({ personalAccount, nonce });
  console.log(`[${label}] UserOperationExecuted event:`, event, "\n");
  return event;
}

// Result of the user-side step of the 0xFE flow: enough information for the
// caller to drive the executor and confirmation steps explicitly.
export type HashInstructionUserSide = {
  xrplTransactionHash: string;
  /** ABI-encoded PackedUserOperation — the bytes the executor delivers via _data. */
  data: `0x${string}`;
  /** Sum of call.value across the UserOp; the executor must forward this as msg.value. */
  totalCallValue: bigint;
  /** Nonce used in the UserOp; pair (personalAccount, nonce) identifies the UserOperationExecuted log. */
  nonce: bigint;
};

/**
 * Step 1 of the 0xFE flow — the **user side**.
 *
 * Encodes the PackedUserOperation, computes the 42-byte 0xFE memo
 * `[0xFE][walletId][fee][keccak256(userOp)]`, and sends an XRPL Payment to the
 * FXRP core-vault address carrying that memo. The full UserOp bytes never
 * touch the XRPL; only the 32-byte hash commitment does.
 *
 * Returns the artifacts the executor step needs (`xrplTransactionHash`,
 * `data`, `totalCallValue`) and the identifiers the confirmation step uses
 * (`personalAccount`, `nonce`).
 */
export async function sendHashInstruction({
  label,
  customInstruction,
  amountXrp,
  personalAccount,
  xrplClient,
  xrplWallet,
}: {
  label: string;
  customInstruction: Call[];
  amountXrp: number;
  personalAccount: Address;
  xrplClient: Client;
  xrplWallet: Wallet;
}): Promise<HashInstructionUserSide> {
  console.log(`[${label}] customInstruction:`, customInstruction, "\n");

  const [nonce, coreVaultXrplAddress] = await Promise.all([
    getNonce(personalAccount),
    getDirectMintingPaymentAddress(),
  ]);
  console.log(`[${label}] current nonce:`, nonce, "\n");

  const { memoData, data } = encodeHashInstructionMemo({
    customInstruction,
    walletId: 0,
    executorFeeUBA: 0n,
    sender: personalAccount,
    nonce,
  });
  const totalCallValue = customInstruction.reduce((acc, call) => acc + call.value, 0n);
  console.log(`[${label}] userOpHash:`, keccak256(data), "\n");
  console.log(`[${label}] _data (${(data.length - 2) / 2} bytes):`, data, "\n");
  console.log(`[${label}] total call.value (native value to attach on executor tx):`, totalCallValue, "\n");

  const transaction = await sendXrplPayment({
    destination: coreVaultXrplAddress,
    amount: amountXrp,
    memos: [{ Memo: { MemoData: memoData.slice(2) } }],
    wallet: xrplWallet,
    client: xrplClient,
  });
  const xrplTransactionHash = transaction.result.hash;
  console.log(`[${label}] XRPL transaction hash:`, xrplTransactionHash, "\n");

  return { xrplTransactionHash, data, totalCallValue, nonce };
}

/**
 * Step 2 of the 0xFE flow — the **executor side**.
 *
 * Acquires an FDC `IXRPPayment.Proof` for the XRPL transaction and submits
 * `AssetManagerFXRP.executeDirectMintingWithData(proof, data, { value })`.
 * `msg.value` flows AssetManager → `MasterAccountController.handleMintedFAssets`
 * → `PersonalAccount.call`, so it must cover the sum of call.value on the UserOp.
 *
 * In production this step is run by a third-party executor service that
 * receives `data` out-of-band (the XRPL only carried the hash). In these
 * example scripts the same externally owned account runs both steps for end-to-end demo purposes.
 *
 * Returns the AssetManager call's receipt; the receipt's logs already contain
 * the `UserOperationExecuted` event because the MasterAccountController executes the UserOp
 * synchronously inside `handleMintedFAssets`.
 */
export async function executeDirectMintingWithData({
  xrplTransactionHash,
  data,
  value,
  xrplClient,
  label,
}: {
  xrplTransactionHash: string;
  data: `0x${string}`;
  value: bigint;
  xrplClient: Client;
  label?: string;
}): Promise<{ hash: `0x${string}`; receipt: TransactionReceipt }> {
  const tag = label ? `[${label}] ` : "";
  // XRPL hashes are 64 hex chars without 0x; the FDC verifier wants a 32-byte hex string.
  const transactionId = (
    xrplTransactionHash.startsWith("0x") ? xrplTransactionHash : `0x${xrplTransactionHash}`
  ).toLowerCase() as `0x${string}`;

  // The FDC XRPPayment attestation type rejects requests whose XRPL transaction
  // isn't yet buried under `XRPL_FDC_CONFIRMATIONS` validated ledgers (3 on
  // XRPL ≈ 12 seconds). `xrpl.submitAndWait` only blocks for the first
  // confirmation, so we have to wait for the rest before calling the verifier.
  console.log(`${tag}Waiting for XRPL transaction to reach ${XRPL_FDC_CONFIRMATIONS} confirmations`);
  const finality = await waitForXrplFinality({
    client: xrplClient,
    transactionHash: xrplTransactionHash,
  });
  console.log(
    `${tag}XRPL finality reached: ${finality.confirmations} confirmations ` +
      `(txLedger=${finality.txLedgerIndex}, validated=${finality.validatedLedgerIndex})`
  );

  // Bind the proof to the operator's externally owned account so AssetManagerFXRP's
  // verifyProofOwnership check (proofOwner == address(0) || == msg.sender)
  // accepts it when we submit executeDirectMintingWithData below.
  console.log(`${tag}Preparing FDC XRPPayment attestation for txid ${transactionId} (proofOwner=${account.address})`);
  const verifierBaseUrl = process.env.VERIFIER_URL_TESTNET;
  const apiKey = process.env.VERIFIER_API_KEY_TESTNET;
  if (!verifierBaseUrl || !apiKey) {
    throw new Error("FDC verifier config missing: set VERIFIER_URL_TESTNET and VERIFIER_API_KEY_TESTNET");
  }
  const { abiEncodedRequest } = await prepareXrpPaymentRequest({
    transactionId,
    proofOwner: account.address,
    verifierBaseUrl,
    apiKey,
  });
  const roundId = await submitAttestationRequest(abiEncodedRequest);
  const proof: IXrpPaymentProof = await retrieveXrpPaymentProofWithRetry(abiEncodedRequest, roundId);
  console.log(`${tag}FDC proof obtained (votingRound=${proof.data.votingRound})`);

  const assetManagerFxrpAddress = await getAssetManagerFXRPAddress();
  console.log(`${tag}Calling executeDirectMintingWithData on ${assetManagerFxrpAddress} (value=${value})`);
  const hash = await walletClient.writeContract({
    account,
    address: assetManagerFxrpAddress,
    abi: iDirectMintingExtAbi,
    functionName: "executeDirectMintingWithData",
    args: [proof, data],
    value,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`${tag}executeDirectMintingWithData tx: ${hash}`);
  return { hash, receipt };
}

/**
 * Step 3 of the 0xFE flow — the **confirmation step**.
 *
 * The MasterAccountController emits `UserOperationExecuted` inside the same Flare transaction as
 * `executeDirectMintingWithData`, so this just parses logs off the executor
 * receipt rather than running a live event watcher. Returns the matching log
 * or throws if not present (which would mean the UserOp didn't execute —
 * e.g. the AssetManager hit a rate limit and emitted `DirectMintingDelayed`
 * instead).
 */
export function findUserOperationExecuted(
  receipt: TransactionReceipt,
  personalAccount: Address,
  nonce: bigint
): UserOperationExecutedEventType {
  const logs = parseEventLogs({
    abi: iMemoInstructionsFacetAbi,
    eventName: "UserOperationExecuted",
    logs: receipt.logs,
  });
  for (const log of logs) {
    const typedLog = log as unknown as UserOperationExecutedEventType;
    if (
      typedLog.args.personalAccount.toLowerCase() === personalAccount.toLowerCase() &&
      typedLog.args.nonce === nonce
    ) {
      return typedLog;
    }
  }
  throw new Error(
    `UserOperationExecuted log not found on receipt ${receipt.transactionHash} for personalAccount=${personalAccount} nonce=${nonce}. ` +
      "The AssetManager may have delayed the minting (rate limit / large minting) — check for DirectMintingDelayed."
  );
}

export async function waitForUserOperationExecuted({
  personalAccount,
  nonce,
}: {
  personalAccount: Address;
  nonce: bigint;
}): Promise<UserOperationExecutedEventType> {
  const masterAccountControllerAddress = await getMasterAccountControllerAddress();

  return new Promise((resolve) => {
    const unwatch = publicClient.watchContractEvent({
      address: masterAccountControllerAddress,
      abi: iMemoInstructionsFacetAbi,
      eventName: "UserOperationExecuted",
      onLogs: (logs) => {
        for (const log of logs) {
          const typedLog = log as UserOperationExecutedEventType;
          if (
            typedLog.args.personalAccount.toLowerCase() !== personalAccount.toLowerCase() ||
            typedLog.args.nonce !== nonce
          ) {
            continue;
          }
          unwatch();
          resolve(typedLog);
          return;
        }
      },
    });
  });
}
