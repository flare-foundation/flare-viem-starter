import { Client, Wallet, dropsToXrp, xrpToDrops } from "xrpl";
import type { Memo } from "xrpl";

export async function getXrpBalance(xrplAddress: string, client?: Client): Promise<number> {
  const ownsClient = client === undefined;
  const xrplClient = client ?? new Client(process.env.XRPL_TESTNET_RPC_URL!);
  if (!xrplClient.isConnected()) {
    await xrplClient.connect();
  }
  try {
    const response = await xrplClient.request({
      command: "account_info",
      account: xrplAddress,
      ledger_index: "validated",
    });
    return Number(dropsToXrp(response.result.account_data.Balance));
  } finally {
    if (ownsClient) {
      await xrplClient.disconnect();
    }
  }
}

export type SendXrplPaymentInputType = {
  destination: string;
  amount: number;
  memos?: Memo[];
  destinationTag?: number;
  wallet: Wallet;
  client: Client;
};

/**
 * Reads the XRPL account's XRP balance and throws if it is below `requiredXrp`.
 * Returns the observed balance on success.
 *
 * Connects the client if it isn't already connected (and disconnects on exit
 * in that case), matching the lifecycle pattern of `sendXrplPayment` and
 * `waitForXrplFinality`.
 */
export async function assertSufficientXrpBalance({
  client,
  address,
  requiredXrp,
}: {
  client: Client;
  address: string;
  requiredXrp: number;
}): Promise<number> {
  const wasConnected = client.isConnected();
  if (!wasConnected) {
    await client.connect();
  }
  try {
    const balanceXrp = await client.getXrpBalance(address);
    if (balanceXrp < requiredXrp) {
      throw new Error(
        `XRPL account ${address} has insufficient XRP balance: ` +
          `${balanceXrp} XRP available, ${requiredXrp} XRP required`
      );
    }
    return balanceXrp;
  } finally {
    if (!wasConnected) {
      await client.disconnect();
    }
  }
}

export async function sendXrplPayment({
  destination,
  memos,
  destinationTag,
  amount,
  wallet,
  client,
}: SendXrplPaymentInputType) {
  await client.connect();

  const preparedTransaction = await client.autofill({
    TransactionType: "Payment",
    Account: wallet.address,
    Amount: xrpToDrops(amount),
    Destination: destination,
    ...(memos && memos.length > 0 ? { Memos: memos } : {}),
    ...(destinationTag !== undefined ? { DestinationTag: destinationTag } : {}),
  });

  const signedTransaction = wallet.sign(preparedTransaction);
  const transaction = await client.submitAndWait(signedTransaction.tx_blob);

  await client.disconnect();

  return transaction;
}

/**
 * Number of XRPL ledger confirmations the FDC Payment attestation type requires
 * before it will produce a proof. Source:
 * https://dev.flare.network/fdc/attestation-types/payment ("XRPL | 3 | ≈12 seconds").
 *
 * `xrpl.submitAndWait` only gets us 1 confirmation (the transaction's own
 * validated ledger), so the executor step must explicitly wait for two more
 * ledgers to close before calling the FDC verifier — otherwise the verifier
 * rejects the prepareRequest call with a "not finalized" status.
 */
export const XRPL_FDC_CONFIRMATIONS = 3;

const FINALITY_POLL_INTERVAL_MS = 2_000;
const FINALITY_TIMEOUT_MS = 60_000;

/**
 * Waits until the XRPL transaction has been buried under enough subsequent
 * validated ledgers to satisfy the FDC Payment attestation finality
 * requirement (default 3 ledgers including the transaction's own).
 *
 * Counts confirmations as `validated_ledger_index - tx_ledger_index + 1`, so a
 * transaction in the latest validated ledger has 1 confirmation.
 *
 * The caller owns the client lifecycle; this helper connects on entry and
 * disconnects on exit (matching `sendXrplPayment`'s pattern), so passing an
 * already-disconnected client is fine.
 */
export async function waitForXrplFinality({
  client,
  transactionHash,
  minConfirmations = XRPL_FDC_CONFIRMATIONS,
  timeoutMs = FINALITY_TIMEOUT_MS,
}: {
  client: Client;
  transactionHash: string;
  minConfirmations?: number;
  timeoutMs?: number;
}): Promise<{ confirmations: number; txLedgerIndex: number; validatedLedgerIndex: number }> {
  if (!client.isConnected()) {
    await client.connect();
  }
  try {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const tx = await client.request({ command: "tx", transaction: transactionHash });
      const txLedgerIndex = tx.result.ledger_index;
      if (txLedgerIndex === undefined) {
        throw new Error(`XRPL tx ${transactionHash} has no ledger_index — not yet validated`);
      }
      const ledger = await client.request({ command: "ledger", ledger_index: "validated" });
      const validatedLedgerIndex = ledger.result.ledger_index;
      const confirmations = validatedLedgerIndex - txLedgerIndex + 1;
      if (confirmations >= minConfirmations) {
        return { confirmations, txLedgerIndex, validatedLedgerIndex };
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `XRPL tx ${transactionHash} did not reach ${minConfirmations} confirmations within ${timeoutMs}ms ` +
            `(current: ${confirmations}, txLedger=${txLedgerIndex}, validated=${validatedLedgerIndex})`
        );
      }
      await new Promise((resolve) => setTimeout(resolve, FINALITY_POLL_INTERVAL_MS));
    }
  } finally {
    await client.disconnect();
  }
}
