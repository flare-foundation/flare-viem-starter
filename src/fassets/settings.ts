import { coston2 } from "@flarenetwork/flare-wagmi-periphery-package";
import { erc20Abi, type Address } from "viem";
import { publicClient } from "../utils/client";

/**
 * Latest block, used to pin every read to one block and to use chain time
 * (not the local clock) when replaying the rate limiter windows off-chain.
 */
export function getLatestBlock() {
  return publicClient.getBlock({ blockTag: "latest" });
}

export function getAssetMintingGranularityUBA(assetManagerAddress: Address, blockNumber?: bigint): Promise<bigint> {
  return publicClient.readContract({
    address: assetManagerAddress,
    abi: coston2.iAssetManagerAbi,
    functionName: "assetMintingGranularityUBA",
    blockNumber,
  });
}

export function getDirectMintingHourlyLimitUBA(assetManagerAddress: Address, blockNumber?: bigint): Promise<bigint> {
  return publicClient.readContract({
    address: assetManagerAddress,
    abi: coston2.iDirectMintingSettingsAbi,
    functionName: "getDirectMintingHourlyLimitUBA",
    blockNumber,
  });
}

export function getDirectMintingDailyLimitUBA(assetManagerAddress: Address, blockNumber?: bigint): Promise<bigint> {
  return publicClient.readContract({
    address: assetManagerAddress,
    abi: coston2.iDirectMintingSettingsAbi,
    functionName: "getDirectMintingDailyLimitUBA",
    blockNumber,
  });
}

export function getDirectMintingHourlyLimiterState(
  assetManagerAddress: Address,
  blockNumber?: bigint
): Promise<readonly [bigint, bigint]> {
  return publicClient.readContract({
    address: assetManagerAddress,
    abi: coston2.iDirectMintingSettingsAbi,
    functionName: "getDirectMintingHourlyLimiterState",
    blockNumber,
  });
}

export function getDirectMintingDailyLimiterState(
  assetManagerAddress: Address,
  blockNumber?: bigint
): Promise<readonly [bigint, bigint]> {
  return publicClient.readContract({
    address: assetManagerAddress,
    abi: coston2.iDirectMintingSettingsAbi,
    functionName: "getDirectMintingDailyLimiterState",
    blockNumber,
  });
}

export function getDirectMintingsUnblockUntilTimestamp(
  assetManagerAddress: Address,
  blockNumber?: bigint
): Promise<bigint> {
  return publicClient.readContract({
    address: assetManagerAddress,
    abi: coston2.iDirectMintingSettingsAbi,
    functionName: "getDirectMintingsUnblockUntilTimestamp",
    blockNumber,
  });
}

export function getDirectMintingLargeMintingThresholdUBA(
  assetManagerAddress: Address,
  blockNumber?: bigint
): Promise<bigint> {
  return publicClient.readContract({
    address: assetManagerAddress,
    abi: coston2.iDirectMintingSettingsAbi,
    functionName: "getDirectMintingLargeMintingThresholdUBA",
    blockNumber,
  });
}

export function getDirectMintingLargeMintingDelaySeconds(
  assetManagerAddress: Address,
  blockNumber?: bigint
): Promise<bigint> {
  return publicClient.readContract({
    address: assetManagerAddress,
    abi: coston2.iDirectMintingSettingsAbi,
    functionName: "getDirectMintingLargeMintingDelaySeconds",
    blockNumber,
  });
}

export function getAssetManagerSettings(assetManagerAddress: Address, blockNumber?: bigint) {
  return publicClient.readContract({
    address: assetManagerAddress,
    abi: coston2.iAssetManagerAbi,
    functionName: "getSettings",
    blockNumber,
  });
}

export function getFAssetTotalSupply(fAssetAddress: Address, blockNumber?: bigint): Promise<bigint> {
  return publicClient.readContract({
    address: fAssetAddress,
    abi: erc20Abi,
    functionName: "totalSupply",
    blockNumber,
  });
}
