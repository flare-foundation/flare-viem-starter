import { type Address, erc20Abi } from "viem";
import { coston2 } from "@flarenetwork/flare-wagmi-periphery-package";
import { dropsToXrp, xrpToDrops } from "xrpl";
import { publicClient } from "./client";
import { getAssetManagerFXRPAddress, getContractAddressByName, getFxrpAddress } from "./flare-contract-registry";
import type { DirectMintingExecutedEventType } from "./event-types";

const MAX_REDEMPTION_QUEUE_PAGES = 100;

export async function getFxrpBalance(address: Address) {
  const fxrpAddress = await getFxrpAddress();
  const fxrpBalance = await publicClient.readContract({
    address: fxrpAddress,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address],
  });
  return fxrpBalance;
}

export async function getFxrpDecimals() {
  const fxrpAddress = await getFxrpAddress();
  const decimals = await publicClient.readContract({
    address: fxrpAddress,
    abi: erc20Abi,
    functionName: "decimals",
    args: [],
  });
  return decimals;
}

export async function getRedemptionQueueTotalValueUBA(assetManagerAddress?: Address): Promise<bigint> {
  const address = assetManagerAddress ?? (await getAssetManagerFXRPAddress());
  const settings = await publicClient.readContract({
    address,
    abi: coston2.iAssetManagerAbi,
    functionName: "getSettings",
  });
  const pageSize = BigInt(settings.maxRedeemedTickets);

  let totalValueUBA = 0n;
  let firstRedemptionTicketId = 0n;

  for (let page = 0; page < MAX_REDEMPTION_QUEUE_PAGES; page++) {
    const [queue, nextRedemptionTicketId] = await publicClient.readContract({
      address,
      abi: coston2.iAssetManagerAbi,
      functionName: "redemptionQueue",
      args: [firstRedemptionTicketId, pageSize],
    });

    for (const ticket of queue) {
      totalValueUBA += ticket.ticketValueUBA;
    }

    if (nextRedemptionTicketId === 0n) {
      return totalValueUBA;
    }
    firstRedemptionTicketId = nextRedemptionTicketId;
  }

  throw new Error(`Redemption queue pagination exceeded ${MAX_REDEMPTION_QUEUE_PAGES} pages.`);
}

export async function validateRedeemAmountUBA(
  requestedAmountUBA: bigint,
  assetManagerAddress?: Address
): Promise<{ minimumRedeemAmountUBA: bigint; redemptionQueueTotalValueUBA: bigint }> {
  const address = assetManagerAddress ?? (await getAssetManagerFXRPAddress());

  const [minimumRedeemAmountUBA, redemptionQueueTotalValueUBA] = await Promise.all([
    publicClient.readContract({
      address,
      abi: coston2.iAssetManagerAbi,
      functionName: "minimumRedeemAmountUBA",
    }),
    getRedemptionQueueTotalValueUBA(address),
  ]);

  if (requestedAmountUBA < minimumRedeemAmountUBA) {
    throw new Error(
      `Redeem amount (${requestedAmountUBA.toString()}) must be at least minimumRedeemAmountUBA (${minimumRedeemAmountUBA.toString()}).`
    );
  }

  if (requestedAmountUBA > redemptionQueueTotalValueUBA) {
    throw new Error(
      `Redeem amount (${requestedAmountUBA.toString()}) exceeds total redemption queue value (${redemptionQueueTotalValueUBA.toString()} UBA).`
    );
  }

  return { minimumRedeemAmountUBA, redemptionQueueTotalValueUBA };
}

export async function calculateAmountToSend(lots: bigint): Promise<bigint> {
  const assetManagerAddress = await getAssetManagerFXRPAddress();
  const settings = await publicClient.readContract({
    address: assetManagerAddress,
    abi: coston2.iAssetManagerAbi,
    functionName: "getSettings",
  });
  return lots * BigInt(settings.lotSizeAMG) * BigInt(settings.assetMintingGranularityUBA);
}

export async function computeDirectMintingPaymentAmountXrp({
  netMintAmountXrp,
}: {
  netMintAmountXrp: number;
}): Promise<number> {
  const assetManagerAddress = await getContractAddressByName("AssetManagerFXRP");
  const [executorFeeUBA, feeBIPS, minimumFeeUBA] = await Promise.all([
    publicClient.readContract({
      address: assetManagerAddress,
      abi: coston2.iDirectMintingSettingsAbi,
      functionName: "getDirectMintingExecutorFeeUBA",
    }),
    publicClient.readContract({
      address: assetManagerAddress,
      abi: coston2.iDirectMintingSettingsAbi,
      functionName: "getDirectMintingFeeBIPS",
    }),
    publicClient.readContract({
      address: assetManagerAddress,
      abi: coston2.iDirectMintingSettingsAbi,
      functionName: "getDirectMintingMinimumFeeUBA",
    }),
  ]);

  const netMintUBA = BigInt(xrpToDrops(netMintAmountXrp));
  const proportionalFeeUBA = (netMintUBA * feeBIPS) / 10_000n;
  const mintingFeeUBA = proportionalFeeUBA > minimumFeeUBA ? proportionalFeeUBA : minimumFeeUBA;
  const totalUBA = netMintUBA + mintingFeeUBA + executorFeeUBA;

  return Number(dropsToXrp(totalUBA.toString()));
}

export function waitForDirectMintingExecuted({
  assetManagerAddress,
  targetAddress,
}: {
  assetManagerAddress: Address;
  targetAddress: Address;
}): Promise<DirectMintingExecutedEventType> {
  return new Promise((resolve) => {
    const unwatch = publicClient.watchContractEvent({
      address: assetManagerAddress,
      abi: coston2.iDirectMintingAbi,
      eventName: "DirectMintingExecuted",
      onLogs: (logs) => {
        for (const log of logs) {
          const typedLog = log as DirectMintingExecutedEventType;
          if (typedLog.args.targetAddress.toLowerCase() !== targetAddress.toLowerCase()) {
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

function formatExecutionAllowedAt(secondsSinceEpoch: bigint): string {
  const iso = new Date(Number(secondsSinceEpoch) * 1000).toISOString();
  const now = BigInt(Math.floor(Date.now() / 1000));
  const delta = Number(secondsSinceEpoch - now);
  const relative = delta >= 0 ? `in ${delta}s` : `${-delta}s ago`;
  return `${secondsSinceEpoch.toString()} (${iso}, ${relative})`;
}

export function waitForDirectMintingOutcome({
  assetManagerAddress,
  targetAddress,
}: {
  assetManagerAddress: Address;
  targetAddress: Address;
}): Promise<DirectMintingExecutedEventType> {
  return new Promise((resolve) => {
    const unwatchDelayed = publicClient.watchContractEvent({
      address: assetManagerAddress,
      abi: coston2.iDirectMintingAbi,
      eventName: "DirectMintingDelayed",
      onLogs: (logs) => {
        for (const log of logs) {
          const executionAllowedAt = log.args.executionAllowedAt;
          if (executionAllowedAt === undefined) {
            continue;
          }
          console.log(
            "DirectMintingDelayed: executionAllowedAt",
            formatExecutionAllowedAt(executionAllowedAt),
            "\n",
          );
        }
      },
    });

    const unwatchExecuted = publicClient.watchContractEvent({
      address: assetManagerAddress,
      abi: coston2.iDirectMintingAbi,
      eventName: "DirectMintingExecuted",
      onLogs: (logs) => {
        for (const log of logs) {
          const typedLog = log as DirectMintingExecutedEventType;
          if (typedLog.args.targetAddress.toLowerCase() !== targetAddress.toLowerCase()) {
            continue;
          }
          unwatchDelayed();
          unwatchExecuted();
          resolve(typedLog);
          return;
        }
      },
    });
  });
}
