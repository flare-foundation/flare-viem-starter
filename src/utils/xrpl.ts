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
