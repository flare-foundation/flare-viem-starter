import {
  concatHex,
  encodeAbiParameters,
  encodeFunctionData,
  fromHex,
  keccak256,
  padHex,
  parseEventLogs,
  toHex,
  type Address,
  type Log,
  type TransactionReceipt,
} from "viem";
import { Client, dropsToXrp, Wallet } from "xrpl";
import { coston2 } from "@flarenetwork/flare-wagmi-periphery-package";
import { account, publicClient, walletClient } from "./client";
import { sendXrplPayment, waitForXrplFinality, XRPL_FDC_CONFIRMATIONS } from "./xrpl";
import { getAssetManagerFXRPAddress, getMasterAccountControllerAddress } from "./flare-contract-registry";
import { abi as iMemoInstructionsFacetAbi } from "../abis/IMemoInstructionsFacet";
import {
  prepareXrpPaymentRequest,
  retrieveXrpPaymentProofWithRetry,
  submitAttestationRequest,
  type IXrpPaymentProof,
} from "./fdc";
import { computeDirectMintingPaymentAmountXrp } from "./fassets";
import type { UserOperationExecutedEventType } from "./event-types";

/** FAssets `PaymentConfirmations.PaymentAlreadyConfirmed()` — XRPL payment already finalized. */
export const PAYMENT_ALREADY_CONFIRMED_SIGNATURE = "0x18dce79f" as const;

const COSTON2_MAX_LOG_BLOCK_RANGE = 29n;
const DEFAULT_DIRECT_MINT_RECEIPT_SEARCH_BLOCKS = 10_000n;

export function isPaymentAlreadyConfirmedError(error: unknown): boolean {
  let current: unknown = error;
  while (current != null && typeof current === "object") {
    const candidate = current as { signature?: string; raw?: string; cause?: unknown };
    if (
      candidate.signature === PAYMENT_ALREADY_CONFIRMED_SIGNATURE ||
      candidate.raw === PAYMENT_ALREADY_CONFIRMED_SIGNATURE
    ) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

export type IgnoreMemoSetEventType = Log & {
  args: {
    personalAccount: Address;
    targetTxId: `0x${string}`;
  };
};

export type NonceIncreasedEventType = Log & {
  args: {
    personalAccount: Address;
    newNonce: bigint;
  };
};

export type PersonalAccountDirectMintingExecutedEventType = Log & {
  args: {
    personalAccount: Address;
    transactionId: `0x${string}`;
    sourceAddress: string;
    amount: bigint;
    executorFee: bigint;
    executor: Address;
  };
};

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
  return concatHex([
    "0xFF",
    toHex(walletId, { size: 1 }),
    toHex(executorFeeUBA, { size: 8 }),
    packedUserOperation,
  ]);
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
  const memoData = concatHex([
    "0xFE",
    toHex(walletId, { size: 1 }),
    toHex(executorFeeUBA, { size: 8 }),
    keccak256(data),
  ]);
  return { memoData, data };
}

/** Normalize an XRPL transaction hash to a 32-byte lowercase `0x`-prefixed hex string. */
export function normalizeXrplTransactionId(hash: string): `0x${string}` {
  return (hash.startsWith("0x") ? hash : `0x${hash}`).toLowerCase() as `0x${string}`;
}

// Opcode 0xE0: skip the memo of a target XRPL transaction on its next direct mint.
// Layout matches the 42-byte header used by 0xFE/0xFF:
// [0xE0 | walletId(1B) | executorFeeUBA(8B) | targetTxId(32B)].
export function encodeSkipMemo({
  targetTxId,
  walletId = 0,
  executorFeeUBA = 0n,
}: {
  targetTxId: `0x${string}`;
  walletId?: number;
  executorFeeUBA?: bigint;
}): `0x${string}` {
  const normalizedTarget = padHex(normalizeXrplTransactionId(targetTxId), { size: 32 });
  return concatHex(["0xE0", toHex(walletId, { size: 1 }), toHex(executorFeeUBA, { size: 8 }), normalizedTarget]);
}

export type SkipMemoUserSide = {
  xrplTransactionHash: string;
  targetTxId: `0x${string}`;
};

/**
 * User side of the 0xE0 recovery flow — send a fee-only XRPL Payment to the
 * core vault carrying a skip-memo instruction that targets the stuck tx ID.
 */
export async function sendSkipMemoInstruction({
  label,
  targetXrplTxHash,
  personalAccount: _personalAccount,
  xrplClient,
  xrplWallet,
  recoveryNetMintAmountXrp = 1,
}: {
  label: string;
  targetXrplTxHash: string;
  personalAccount: Address;
  xrplClient: Client;
  xrplWallet: Wallet;
  /** Net XRP to mint alongside the 0xE0 flag. Must be > 0 — fee-only payments revert on-chain. */
  recoveryNetMintAmountXrp?: number;
}): Promise<SkipMemoUserSide> {
  const targetTxId = normalizeXrplTransactionId(targetXrplTxHash);
  const memoData = encodeSkipMemo({ targetTxId });
  console.log(`[${label}] 0xE0 skip-memo targeting:`, targetTxId, "\n");
  console.log(`[${label}] memo (${(memoData.length - 2) / 2} bytes):`, memoData, "\n");

  const [coreVaultXrplAddress, amountXrp] = await Promise.all([
    getDirectMintingPaymentAddress(),
    computeDirectMintingPaymentAmountXrp({ netMintAmountXrp: recoveryNetMintAmountXrp }),
  ]);
  console.log(
    `[${label}] recovery payment amount (XRP, net mint ${recoveryNetMintAmountXrp} + fees):`,
    amountXrp,
    "\n"
  );

  const transaction = await sendXrplPayment({
    destination: coreVaultXrplAddress,
    amount: amountXrp,
    memos: [{ Memo: { MemoData: memoData.slice(2) } }],
    wallet: xrplWallet,
    client: xrplClient,
  });
  const xrplTransactionHash = transaction.result.hash;
  console.log(`[${label}] recovery XRPL transaction hash:`, xrplTransactionHash, "\n");

  return { xrplTransactionHash, targetTxId };
}

// Opcode 0xE1: fast-forward the personal account's memo-instruction nonce.
// Layout matches the 42-byte header used by 0xE0:
// [0xE1 | walletId(1B) | executorFeeUBA(8B) | newNonce(32B)].
export function encodeFastForwardNonce({
  newNonce,
  walletId = 0,
  executorFeeUBA = 0n,
}: {
  newNonce: bigint;
  walletId?: number;
  executorFeeUBA?: bigint;
}): `0x${string}` {
  const paddedNonce = padHex(toHex(newNonce), { size: 32 });
  return concatHex(["0xE1", toHex(walletId, { size: 1 }), toHex(executorFeeUBA, { size: 8 }), paddedNonce]);
}

export function assertValidNonceIncrease(currentNonce: bigint, targetNewNonce: bigint): void {
  if (targetNewNonce <= currentNonce) {
    throw new Error(`newNonce ${targetNewNonce} must be > current nonce ${currentNonce}`);
  }
  if (targetNewNonce - currentNonce > 2n ** 32n - 1n) {
    throw new Error(`nonce jump ${targetNewNonce - currentNonce} exceeds uint32.max`);
  }
}

export type FastForwardNonceUserSide = {
  xrplTransactionHash: string;
  newNonce: bigint;
};

/**
 * User side of the 0xE1 flow — send an XRPL Payment to the core vault carrying
 * a fast-forward-nonce instruction that sets the memo nonce to `newNonce`.
 */
export async function sendFastForwardNonceInstruction({
  label,
  newNonce,
  personalAccount: _personalAccount,
  xrplClient,
  xrplWallet,
  netMintAmountXrp = 1,
}: {
  label: string;
  newNonce: bigint;
  personalAccount: Address;
  xrplClient: Client;
  xrplWallet: Wallet;
  /** Net XRP to mint alongside the 0xE1 flag. Must be > 0 — fee-only payments revert on-chain. */
  netMintAmountXrp?: number;
}): Promise<FastForwardNonceUserSide> {
  const memoData = encodeFastForwardNonce({ newNonce });
  console.log(`[${label}] 0xE1 fast-forward nonce to:`, newNonce, "\n");
  console.log(`[${label}] memo (${(memoData.length - 2) / 2} bytes):`, memoData, "\n");

  const [coreVaultXrplAddress, amountXrp] = await Promise.all([
    getDirectMintingPaymentAddress(),
    computeDirectMintingPaymentAmountXrp({ netMintAmountXrp }),
  ]);
  console.log(
    `[${label}] payment amount (XRP, net mint ${netMintAmountXrp} + fees):`,
    amountXrp,
    "\n"
  );

  const transaction = await sendXrplPayment({
    destination: coreVaultXrplAddress,
    amount: amountXrp,
    memos: [{ Memo: { MemoData: memoData.slice(2) } }],
    wallet: xrplWallet,
    client: xrplClient,
  });
  const xrplTransactionHash = transaction.result.hash;
  console.log(`[${label}] XRPL transaction hash:`, xrplTransactionHash, "\n");

  return { xrplTransactionHash, newNonce };
}

async function fetchXrpPaymentProof({
  xrplTransactionHash,
  xrplClient,
  label,
}: {
  xrplTransactionHash: string;
  xrplClient: Client;
  label?: string;
}): Promise<IXrpPaymentProof> {
  const tag = label ? `[${label}] ` : "";
  const transactionId = normalizeXrplTransactionId(xrplTransactionHash);

  console.log(`${tag}Waiting for XRPL transaction to reach ${XRPL_FDC_CONFIRMATIONS} confirmations`);
  const finality = await waitForXrplFinality({
    client: xrplClient,
    transactionHash: xrplTransactionHash,
  });
  console.log(
    `${tag}XRPL finality reached: ${finality.confirmations} confirmations ` +
      `(txLedger=${finality.txLedgerIndex}, validated=${finality.validatedLedgerIndex})`
  );

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
  const proof = await retrieveXrpPaymentProofWithRetry(abiEncodedRequest, roundId);
  console.log(`${tag}FDC proof obtained (votingRound=${proof.data.votingRound})`);
  return proof;
}

/**
 * Load the Flare receipt for an XRPL direct-mint payment that was already finalized
 * (e.g. by a relayer). Scans `DirectMintingExecutedToSmartAccount` in block windows
 * because Coston2 RPC limits `eth_getLogs` range.
 */
export async function findDirectMintingReceiptForTransactionId(
  transactionId: `0x${string}`,
  options?: { label?: string; maxBlocksToSearch?: bigint }
): Promise<TransactionReceipt> {
  const tag = options?.label ? `[${options.label}] ` : "";
  const normalized = normalizeXrplTransactionId(transactionId);
  const assetManagerFxrpAddress = await getAssetManagerFXRPAddress();
  const latest = await publicClient.getBlockNumber();
  const maxBlocksToSearch = options?.maxBlocksToSearch ?? DEFAULT_DIRECT_MINT_RECEIPT_SEARCH_BLOCKS;
  const earliest = latest > maxBlocksToSearch ? latest - maxBlocksToSearch : 0n;

  for (let toBlock = latest; toBlock >= earliest; toBlock -= COSTON2_MAX_LOG_BLOCK_RANGE + 1n) {
    const fromBlock = toBlock > COSTON2_MAX_LOG_BLOCK_RANGE ? toBlock - COSTON2_MAX_LOG_BLOCK_RANGE : earliest;
    const logs = await publicClient.getContractEvents({
      address: assetManagerFxrpAddress,
      abi: coston2.iDirectMintingAbi,
      eventName: "DirectMintingExecutedToSmartAccount",
      args: { transactionId: normalized },
      fromBlock,
      toBlock,
    });
    if (logs.length > 0) {
      const mintLog = logs[logs.length - 1]!;
      console.log(
        `${tag}Found existing direct mint in block ${mintLog.blockNumber} (tx ${mintLog.transactionHash})`
      );
      return publicClient.getTransactionReceipt({ hash: mintLog.transactionHash });
    }
    if (fromBlock <= earliest) {
      break;
    }
  }

  throw new Error(
    `DirectMintingExecutedToSmartAccount not found for transactionId=${normalized} ` +
      `(searched the last ${maxBlocksToSearch} blocks)`
  );
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
  reuseExistingMint = false,
}: {
  xrplTransactionHash: string;
  data: `0x${string}`;
  value: bigint;
  xrplClient: Client;
  label?: string;
  /**
   * When true, a relayer-finalized payment (`PaymentAlreadyConfirmed`) returns the
   * existing on-chain mint receipt instead of failing.
   */
  reuseExistingMint?: boolean;
}): Promise<{ hash: `0x${string}`; receipt: TransactionReceipt }> {
  const tag = label ? `[${label}] ` : "";
  const transactionId = normalizeXrplTransactionId(xrplTransactionHash);
  const proof = await fetchXrpPaymentProof({
    xrplTransactionHash,
    xrplClient,
    ...(label !== undefined ? { label } : {}),
  });

  const assetManagerFxrpAddress = await getAssetManagerFXRPAddress();
  console.log(`${tag}Calling executeDirectMintingWithData on ${assetManagerFxrpAddress} (value=${value})`);
  try {
    const hash = await walletClient.writeContract({
      account,
      address: assetManagerFxrpAddress,
      abi: coston2.iDirectMintingAbi,
      functionName: "executeDirectMintingWithData",
      args: [proof, data],
      value,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    console.log(`${tag}executeDirectMintingWithData tx: ${hash}`);
    if (receipt.status === "reverted") {
      if (!reuseExistingMint) {
        throw new Error(
          `${tag}executeDirectMintingWithData reverted (tx ${hash}). ` +
            "The XRPL payment may already be finalized on Flare — retry with reuseExistingMint."
        );
      }
      console.log(`${tag}Transaction reverted — loading relayer-finalized mint receipt.`);
      const existingReceipt = await findDirectMintingReceiptForTransactionId(transactionId, {
        ...(label !== undefined ? { label } : {}),
      });
      return { hash: existingReceipt.transactionHash, receipt: existingReceipt };
    }
    return { hash, receipt };
  } catch (error) {
    if (!reuseExistingMint || !isPaymentAlreadyConfirmedError(error)) {
      throw error;
    }
    console.log(`${tag}Payment already finalized on Flare — loading existing mint receipt.`);
    const receipt = await findDirectMintingReceiptForTransactionId(transactionId, {
      ...(label !== undefined ? { label } : {}),
    });
    return { hash: receipt.transactionHash, receipt };
  }
}

/**
 * Executor-side finalize for legacy direct mints (32-byte payment reference memo).
 *
 * Smart-account memos (0xE0–0xFF) must use `executeDirectMintingWithData` instead.
 * Re-submitting an already-finalized XRPL payment reverts with `PaymentAlreadyConfirmed()`
 * (`0x18dce79f`).
 */
export async function executeDirectMinting({
  xrplTransactionHash,
  xrplClient,
  label,
}: {
  xrplTransactionHash: string;
  xrplClient: Client;
  label?: string;
}): Promise<{ hash: `0x${string}`; receipt: TransactionReceipt }> {
  const tag = label ? `[${label}] ` : "";
  const proof = await fetchXrpPaymentProof({
    xrplTransactionHash,
    xrplClient,
    ...(label !== undefined ? { label } : {}),
  });

  const assetManagerFxrpAddress = await getAssetManagerFXRPAddress();
  console.log(`${tag}Calling executeDirectMinting on ${assetManagerFxrpAddress}`);
  const hash = await walletClient.writeContract({
    account,
    address: assetManagerFxrpAddress,
    abi: coston2.iDirectMintingAbi,
    functionName: "executeDirectMinting",
    args: [proof],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`${tag}executeDirectMinting tx: ${hash}`);
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

/** Throws when the executor receipt contains `DirectMintingDelayed` (rate-limited mint). */
export function assertNotDirectMintingDelayed(receipt: TransactionReceipt, label?: string): void {
  const logs = parseEventLogs({
    abi: coston2.iDirectMintingAbi,
    eventName: "DirectMintingDelayed",
    logs: receipt.logs,
  });
  if (logs.length === 0) {
    return;
  }
  const delayed = logs[0]!;
  const tag = label ? `[${label}] ` : "";
  throw new Error(
    `${tag}Direct minting was delayed (rate limit). ` +
      `executionAllowedAt=${delayed.args.executionAllowedAt}. ` +
      `Re-call with the same FDC proof after that timestamp. ` +
      `Do not send a second XRPL payment with the same nonce.`
  );
}

export function findIgnoreMemoSet(
  receipt: TransactionReceipt,
  personalAccount: Address,
  targetTxId: `0x${string}`
): IgnoreMemoSetEventType {
  assertNotDirectMintingDelayed(receipt);
  const logs = parseEventLogs({
    abi: iMemoInstructionsFacetAbi,
    eventName: "IgnoreMemoSet",
    logs: receipt.logs,
  });
  const normalizedTarget = normalizeXrplTransactionId(targetTxId);
  for (const log of logs) {
    const typedLog = log as unknown as IgnoreMemoSetEventType;
    if (
      typedLog.args.personalAccount.toLowerCase() === personalAccount.toLowerCase() &&
      normalizeXrplTransactionId(typedLog.args.targetTxId) === normalizedTarget
    ) {
      return typedLog;
    }
  }
  throw new Error(
    `IgnoreMemoSet log not found on receipt ${receipt.transactionHash} ` +
      `for personalAccount=${personalAccount} targetTxId=${normalizedTarget}`
  );
}

export function findNonceIncreased(
  receipt: TransactionReceipt,
  personalAccount: Address,
  newNonce: bigint
): NonceIncreasedEventType {
  assertNotDirectMintingDelayed(receipt);
  const logs = parseEventLogs({
    abi: iMemoInstructionsFacetAbi,
    eventName: "NonceIncreased",
    logs: receipt.logs,
  });
  for (const log of logs) {
    const typedLog = log as unknown as NonceIncreasedEventType;
    if (
      typedLog.args.personalAccount.toLowerCase() === personalAccount.toLowerCase() &&
      typedLog.args.newNonce === newNonce
    ) {
      return typedLog;
    }
  }
  throw new Error(
    `NonceIncreased log not found on receipt ${receipt.transactionHash} ` +
      `for personalAccount=${personalAccount} newNonce=${newNonce}`
  );
}

export function findPersonalAccountDirectMintingExecuted(
  receipt: TransactionReceipt,
  personalAccount: Address,
  transactionId: `0x${string}`
): PersonalAccountDirectMintingExecutedEventType {
  assertNotDirectMintingDelayed(receipt);
  const logs = parseEventLogs({
    abi: iMemoInstructionsFacetAbi,
    eventName: "DirectMintingExecuted",
    logs: receipt.logs,
  });
  const normalizedTxId = normalizeXrplTransactionId(transactionId);
  for (const log of logs) {
    const typedLog = log as unknown as PersonalAccountDirectMintingExecutedEventType;
    if (
      typedLog.args.personalAccount.toLowerCase() === personalAccount.toLowerCase() &&
      normalizeXrplTransactionId(typedLog.args.transactionId) === normalizedTxId
    ) {
      return typedLog;
    }
  }
  throw new Error(
    `DirectMintingExecuted log not found on receipt ${receipt.transactionHash} ` +
      `for personalAccount=${personalAccount} transactionId=${normalizedTxId}`
  );
}

/** Log FXRP credit details from a direct-mint executor receipt. */
export function logPersonalAccountFxrpCredit({
  label,
  receipt,
  personalAccount,
  xrplTransactionId,
}: {
  label: string;
  receipt: TransactionReceipt;
  personalAccount: Address;
  xrplTransactionId: `0x${string}`;
}): PersonalAccountDirectMintingExecutedEventType {
  const mintEvent = findPersonalAccountDirectMintingExecuted(receipt, personalAccount, xrplTransactionId);
  const normalizedTxId = normalizeXrplTransactionId(xrplTransactionId);
  console.log(`[${label}] FXRP credited to personal account:`, personalAccount);
  console.log(`[${label}] XRPL transaction id:`, normalizedTxId);
  console.log(`[${label}] Flare mint tx:`, receipt.transactionHash);
  console.log(`[${label}] Amount (UBA):`, mintEvent.args.amount);
  console.log(`[${label}] Executor fee (UBA):`, mintEvent.args.executorFee);
  console.log(`[${label}] Executor:`, mintEvent.args.executor, "\n");
  return mintEvent;
}

export async function isStuckTransactionIdUsed(targetTxId: `0x${string}`): Promise<boolean> {
  const masterAccountControllerAddress = await getMasterAccountControllerAddress();
  return (await publicClient.readContract({
    address: masterAccountControllerAddress,
    abi: iMemoInstructionsFacetAbi,
    functionName: "isTransactionIdUsed",
    args: [normalizeXrplTransactionId(targetTxId)],
  })) as boolean;
}

export type StuckDirectMintDiagnosis = {
  targetTxId: `0x${string}`;
  transactionIdUsed: boolean;
  nonce: bigint;
  pinnedExecutor: Address;
};

/** Read on-chain state for a potentially stuck direct-mint XRPL payment. */
export async function diagnoseStuckDirectMint({
  stuckXrplTxHash,
  personalAccount,
}: {
  stuckXrplTxHash: string;
  personalAccount: Address;
}): Promise<StuckDirectMintDiagnosis> {
  const targetTxId = normalizeXrplTransactionId(stuckXrplTxHash);
  const masterAccountControllerAddress = await getMasterAccountControllerAddress();

  const [transactionIdUsed, nonce, pinnedExecutor] = await Promise.all([
    isStuckTransactionIdUsed(targetTxId),
    getNonce(personalAccount),
    publicClient.readContract({
      address: masterAccountControllerAddress,
      abi: iMemoInstructionsFacetAbi,
      functionName: "getExecutor",
      args: [personalAccount],
    }) as Promise<Address>,
  ]);

  console.log("--- Stuck direct mint diagnosis ---");
  console.log("targetTxId:", targetTxId);
  console.log("isTransactionIdUsed:", transactionIdUsed);
  console.log("current memo nonce:", nonce);
  console.log("pinned executor:", pinnedExecutor);
  if (transactionIdUsed) {
    console.warn("WARNING: transaction ID already used on Flare — recovery is not applicable.\n");
  } else {
    console.log("Transaction not yet minted on Flare — recovery via 0xE0 is applicable.\n");
  }

  return { targetTxId, transactionIdUsed, nonce, pinnedExecutor };
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
