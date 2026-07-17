import { decodeAbiParameters, toHex, type AbiParameter, type ContractFunctionArgs } from "viem";
import { getContractAddressByName } from "./flare-contract-registry";
import { publicClient } from "./client";
import { walletClient } from "./client";
import { account } from "./client";
import { coston2 } from "@flarenetwork/flare-wagmi-periphery-package";

// Proof / Response types derived directly from the periphery package's ABIs.
// `verifyWeb2Json` and `verifyXRPPayment` each take a single Proof tuple param
// whose `data` field is the matching Response struct — extracting the input
// type gives us a TypeScript shape that stays in sync with the on-chain ABI
// automatically.
export type Web2JsonProof = ContractFunctionArgs<typeof coston2.iWeb2JsonVerificationAbi, "view", "verifyWeb2Json">[0];
export type Web2JsonResponse = Web2JsonProof["data"];

export type IXrpPaymentProof = ContractFunctionArgs<
  typeof coston2.ixrpPaymentVerificationAbi,
  "view",
  "verifyXRPPayment"
>[0];
export type IXrpPaymentResponse = IXrpPaymentProof["data"];

const POLL_INTERVAL_MS = 30_000;
const DA_LAYER_POLL_MS = 10_000;
const RETRY_SLEEP_MS = 20_000;
const RETRY_ATTEMPTS = 10;

// Pull the IWeb2Json.Response ABI tuple from the periphery package's
// verifyWeb2Json fragment. The result is one decode-side cast we do once.
const iWeb2JsonResponseAbiParam = (
  coston2.iWeb2JsonVerificationAbi.find((f) => f.type === "function" && "name" in f && f.name === "verifyWeb2Json") as
    | { inputs: readonly { components?: readonly AbiParameter[] }[] }
    | undefined
)?.inputs?.[0]?.components?.[1];

function decodeWeb2JsonResponse(responseHex: `0x${string}`): Web2JsonResponse {
  if (!iWeb2JsonResponseAbiParam) {
    throw new Error("IWeb2Json.Response ABI not found on iWeb2JsonVerificationAbi.verifyWeb2Json");
  }
  const [decoded] = decodeAbiParameters([iWeb2JsonResponseAbiParam], responseHex);
  return decoded as Web2JsonResponse;
}

async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<{ statusCode: number; body: string }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const responseBody = await response.text();
  return { statusCode: response.status, body: responseBody };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Prepares an FDC attestation request by calling the verifier's prepareRequest endpoint.
 * @see https://dev.flare.network/fdc/guides/hardhat/web-2-json
 */
export async function prepareAttestationRequest(
  verifierUrl: string,
  apiKey: string,
  attestationTypeBase: string,
  sourceIdBase: string,
  requestBody: Record<string, unknown>
): Promise<{ abiEncodedRequest: string; [key: string]: unknown }> {
  console.log("Url:", verifierUrl, "\n");
  const attestationType = toHex(attestationTypeBase, { size: 32 });
  const sourceId = toHex(sourceIdBase, { size: 32 });

  const request = {
    attestationType,
    sourceId,
    requestBody,
  };
  console.log("Prepared request:\n", request, "\n");

  const { statusCode, body } = await postJson(verifierUrl, request, { "X-API-KEY": apiKey });

  if (statusCode !== 200) {
    throw new Error(`Response status is not OK, status ${statusCode}\n`);
  }
  console.log("Response status is OK\n");

  const data = JSON.parse(body) as { abiEncodedRequest?: string; status?: string; errorMessage?: string };
  if (data.status && !data.status.startsWith("OK") && data.status !== "VALID") {
    const detail = data.errorMessage ? ` (${data.errorMessage})` : "";
    throw new Error(`Verifier rejected request: ${data.status}${detail}. Response: ${body}`);
  }
  if (data.abiEncodedRequest === undefined) {
    throw new Error(`Verifier response missing abiEncodedRequest. Body: ${body}`);
  }
  return data as { abiEncodedRequest: string; [key: string]: unknown };
}

/**
 * Submits an FDC attestation request on-chain and returns the voting round id.
 */
export async function submitAttestationRequest(abiEncodedRequest: `0x${string}`): Promise<number> {
  const fdcHubAddress = await getContractAddressByName("FdcHub");
  const feeConfigAddress = await publicClient.readContract({
    address: fdcHubAddress,
    abi: coston2.iFdcHubAbi,
    functionName: "fdcRequestFeeConfigurations",
    args: [],
  });
  const requestFee = await publicClient.readContract({
    address: feeConfigAddress,
    abi: coston2.iFdcRequestFeeConfigurationsAbi,
    functionName: "getRequestFee",
    args: [abiEncodedRequest],
  });

  const hash = await walletClient.writeContract({
    account,
    address: fdcHubAddress,
    abi: coston2.iFdcHubAbi,
    functionName: "requestAttestation",
    args: [abiEncodedRequest],
    value: requestFee,
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const block = await publicClient.getBlock({ blockNumber: receipt.blockNumber });
  const blockTimestamp = BigInt(block.timestamp);

  const flareSystemsManagerAddress = await getContractAddressByName("FlareSystemsManager");
  const [firstVotingRoundStartTs, votingEpochDurationSeconds] = await Promise.all([
    publicClient.readContract({
      address: flareSystemsManagerAddress,
      abi: coston2.iFlareSystemsManagerAbi,
      functionName: "firstVotingRoundStartTs",
      args: [],
    }),
    publicClient.readContract({
      address: flareSystemsManagerAddress,
      abi: coston2.iFlareSystemsManagerAbi,
      functionName: "votingEpochDurationSeconds",
      args: [],
    }),
  ]);

  const roundId = Number((blockTimestamp - firstVotingRoundStartTs) / votingEpochDurationSeconds);
  console.log("FDC attestation submitted. Round id:", roundId);
  console.log(
    `View round progress in explorer: https://coston2-systems-explorer.flare.network/voting-round/${roundId}?tab=fdc`
  );
  return roundId;
}

/**
 * Waits for the FDC voting round to finalize, then polls the DA layer for the
 * proof, applying `decodeResponse` to the raw response hex. Both the
 * Web2Json and XRPPayment flows go through here.
 */
async function pollFdcProof<TResponse>(
  abiEncodedRequest: string,
  roundId: number,
  decodeResponse: (hex: `0x${string}`) => TResponse
): Promise<{ merkleProof: readonly `0x${string}`[]; data: TResponse }> {
  const daLayerProofUrl =
    (process.env.COSTON2_DA_LAYER_URL ?? "https://ctn2-data-availability.flare.network").replace(/\/$/, "") +
    "/api/v1/fdc/proof-by-request-round-raw";
  const relayAddress = await getContractAddressByName("Relay");
  const fdcVerificationAddress = await getContractAddressByName("FdcVerification");
  const protocolId = await publicClient.readContract({
    address: fdcVerificationAddress,
    abi: coston2.iFdcVerificationAbi,
    functionName: "fdcProtocolId",
    args: [],
  });

  console.log("Waiting for FDC round to finalize...");
  while (true) {
    const finalized = await publicClient.readContract({
      address: relayAddress,
      abi: coston2.iRelayAbi,
      functionName: "isFinalized",
      args: [BigInt(protocolId), BigInt(roundId)],
    });
    if (finalized) break;
    await sleep(POLL_INTERVAL_MS);
  }
  console.log("Round finalized.\n");

  const request = { votingRoundId: roundId, requestBytes: abiEncodedRequest };
  await sleep(DA_LAYER_POLL_MS);

  for (let i = 0; i < RETRY_ATTEMPTS; i++) {
    const { body } = await postJson(daLayerProofUrl, request);
    const raw = JSON.parse(body) as { response_hex?: string; proof?: readonly `0x${string}`[] };
    if (raw.response_hex !== undefined) {
      return { merkleProof: raw.proof ?? [], data: decodeResponse(raw.response_hex as `0x${string}`) };
    }
    await sleep(DA_LAYER_POLL_MS);
  }
  throw new Error(`Failed to retrieve FDC proof after ${RETRY_ATTEMPTS} DA-layer polls`);
}

async function withRetry<T>(fn: () => Promise<T>, attempts: number, label: string): Promise<T> {
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      console.error(e, "\nRemaining attempts:", attempts - i - 1);
      await sleep(RETRY_SLEEP_MS);
    }
  }
  throw new Error(`Failed to ${label} after ${attempts} attempts`);
}

export async function retrieveDataAndProof(abiEncodedRequest: string, roundId: number): Promise<Web2JsonProof> {
  return pollFdcProof(abiEncodedRequest, roundId, decodeWeb2JsonResponse) as Promise<Web2JsonProof>;
}

export async function retrieveDataAndProofWithRetry(
  abiEncodedRequest: string,
  roundId: number,
  attempts: number = RETRY_ATTEMPTS
): Promise<Web2JsonProof> {
  return withRetry(() => retrieveDataAndProof(abiEncodedRequest, roundId), attempts, "retrieve Web2Json proof");
}

// --- XRP Payment proofs (IXRPPayment.Proof) ---------------------------------
//
// Used by the 0xFE memo-opcode flow: the executor (or, in the example scripts,
// the script itself acting as its own executor) needs an IXRPPayment.Proof for
// the XRPL transaction that carried the hash memo, then calls
// AssetManagerFXRP.executeDirectMintingWithData(proof, _data, { value }).

// Pull the IXRPPayment.Response ABI tuple from the periphery package's
// verifyXRPPayment fragment — same approach as decodeWeb2JsonResponse above.
const iXrpPaymentResponseAbiParam = (
  coston2.ixrpPaymentVerificationAbi.find(
    (f) => f.type === "function" && "name" in f && f.name === "verifyXRPPayment"
  ) as { inputs: readonly { components?: readonly AbiParameter[] }[] } | undefined
)?.inputs?.[0]?.components?.[1];

function decodeXrpPaymentResponse(responseHex: `0x${string}`): IXrpPaymentResponse {
  if (!iXrpPaymentResponseAbiParam) {
    throw new Error("IXRPPayment.Response ABI not found on ixrpPaymentVerificationAbi.verifyXRPPayment");
  }
  const [decoded] = decodeAbiParameters([iXrpPaymentResponseAbiParam], responseHex);
  return decoded as IXrpPaymentResponse;
}

/** FDC XRPPayment attestation type — distinct from the legacy generic `Payment` (id 0x01). */
const FDC_ATTESTATION_TYPE_XRP_PAYMENT = "XRPPayment";
/** Default FDC XRP source id on Coston2 testnet; on mainnet use "XRP". */
const FDC_XRP_SOURCE_ID_DEFAULT = "testXRP";

/**
 * Prepares an FDC `XRPPayment` attestation request (attestation type id 0x08,
 * `IXRPPayment.Proof`) for an XRPL transaction. This is the XRPL-specific
 * attestation type required by AssetManagerFXRP — not the legacy generic
 * `Payment` (id 0x01) type, which has a different response shape.
 *
 * `proofOwner` is checked by AssetManagerFXRP via TransactionAttestation
 * .verifyProofOwnership: it must be either the zero address (proof usable by
 * anyone) or the address that ends up calling `executeDirectMintingWithData`.
 * Pass the address of the executor's externally owned account to bind the proof to it.
 */
export async function prepareXrpPaymentRequest({
  transactionId,
  proofOwner,
  verifierBaseUrl,
  apiKey,
  sourceIdBase = FDC_XRP_SOURCE_ID_DEFAULT,
}: {
  transactionId: `0x${string}`;
  proofOwner: `0x${string}`;
  verifierBaseUrl: string;
  apiKey: string;
  sourceIdBase?: string;
}): Promise<{ abiEncodedRequest: `0x${string}` }> {
  const verifierUrl = `${verifierBaseUrl.replace(/\/$/, "")}/verifier/xrp/XRPPayment/prepareRequest`;
  const result = await prepareAttestationRequest(verifierUrl, apiKey, FDC_ATTESTATION_TYPE_XRP_PAYMENT, sourceIdBase, {
    transactionId,
    proofOwner,
  });
  return { abiEncodedRequest: result.abiEncodedRequest as `0x${string}` };
}

export async function retrieveXrpPaymentProof(
  abiEncodedRequest: `0x${string}`,
  roundId: number
): Promise<IXrpPaymentProof> {
  return pollFdcProof(abiEncodedRequest, roundId, decodeXrpPaymentResponse) as Promise<IXrpPaymentProof>;
}

export async function retrieveXrpPaymentProofWithRetry(
  abiEncodedRequest: `0x${string}`,
  roundId: number,
  attempts: number = RETRY_ATTEMPTS
): Promise<IXrpPaymentProof> {
  return withRetry(() => retrieveXrpPaymentProof(abiEncodedRequest, roundId), attempts, "retrieve XRPPayment proof");
}
