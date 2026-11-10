// Run: pnpm run script src/fassets/emergency-pause.ts
//
// Read-only. Prefights FAssets emergency / minting pause state on
// AssetManagerFXRP before minting or redeeming.
// Docs: https://dev.flare.network/fassets/emergency-pause#check-pause-status

import { coston2 } from "@flarenetwork/flare-wagmi-periphery-package";
import type { Address } from "viem";
import { publicClient } from "../utils/client";
import { getContractAddressByName } from "../utils/flare-contract-registry";

// On-chain EmergencyPause.Level returned by emergencyPauseLevel().
const EmergencyPauseLevel = {
  NONE: 0,
  START_OPERATIONS: 1,
  FULL: 2,
  FULL_AND_TRANSFER: 3,
} as const;

function emergencyPauseLevelName(level: number): string {
  switch (level) {
    case EmergencyPauseLevel.NONE:
      return "NONE";
    case EmergencyPauseLevel.START_OPERATIONS:
      return "START_OPERATIONS";
    case EmergencyPauseLevel.FULL:
      return "FULL";
    case EmergencyPauseLevel.FULL_AND_TRANSFER:
      return "FULL_AND_TRANSFER";
    default:
      return `LEVEL_${level}`;
  }
}

function formatEmergencyPauseLevel(level: number): string {
  return `${emergencyPauseLevelName(level)} (${level})`;
}

function formatPausedUntil(timestamp: bigint, now: bigint): string {
  if (timestamp === 0n) {
    return "not set (0)";
  }

  const iso = new Date(Number(timestamp) * 1000).toISOString();
  const deltaSeconds = Number(timestamp - now);
  if (deltaSeconds >= 0) {
    return `${iso} (in ${deltaSeconds}s)`;
  }
  return `${iso} (${Math.abs(deltaSeconds)}s ago — re-check emergencyPaused())`;
}

function emergencyPauseEffect(level: number): string {
  switch (level) {
    case EmergencyPauseLevel.START_OPERATIONS:
      return "New minting, redemption, and liquidation are paused. executeDirectMinting reverts with EmergencyPauseActive. FXRP transfers still work.";
    case EmergencyPauseLevel.FULL:
      return "Minting, redemption, and finishing in-progress mints and redeems are paused. FXRP transfers still work.";
    case EmergencyPauseLevel.FULL_AND_TRANSFER:
      return "The FAsset system is fully paused, including FXRP transfers. Affected calls revert with EmergencyPauseActive.";
    default:
      return "Most mint, redeem, and liquidation calls revert with EmergencyPauseActive.";
  }
}

async function readPauseStatus(assetManagerAddress: Address) {
  const [emergencyPaused, emergencyPauseLevel, emergencyPausedUntil, mintingPaused] =
    await Promise.all([
      publicClient.readContract({
        address: assetManagerAddress,
        abi: coston2.iAssetManagerInfoAbi,
        functionName: "emergencyPaused",
      }),
      publicClient.readContract({
        address: assetManagerAddress,
        abi: coston2.iAssetManagerInfoAbi,
        functionName: "emergencyPauseLevel",
      }),
      publicClient.readContract({
        address: assetManagerAddress,
        abi: coston2.iAssetManagerInfoAbi,
        functionName: "emergencyPausedUntil",
      }),
      publicClient.readContract({
        address: assetManagerAddress,
        abi: coston2.iAssetManagerInfoAbi,
        functionName: "mintingPaused",
      }),
    ]);

  return {
    emergencyPaused,
    emergencyPauseLevel: Number(emergencyPauseLevel),
    emergencyPausedUntil,
    mintingPaused,
  };
}

async function main() {
  const assetManagerAddress = await getContractAddressByName("AssetManagerFXRP");
  const [{ timestamp: now }, pause] = await Promise.all([
    publicClient.getBlock({ blockTag: "latest" }),
    readPauseStatus(assetManagerAddress),
  ]);

  console.log("AssetManagerFXRP address:", assetManagerAddress);
  console.log("Emergency pause:", pause.emergencyPaused ? "PAUSED" : "not paused");
  console.log("Emergency pause level:", formatEmergencyPauseLevel(pause.emergencyPauseLevel));
  console.log("Paused until:", formatPausedUntil(pause.emergencyPausedUntil, now));
  console.log("Minting pause:", pause.mintingPaused ? "PAUSED" : "not paused");
  console.log();

  if (pause.emergencyPaused) {
    console.log("FAsset system is paused.");
    console.log(emergencyPauseEffect(pause.emergencyPauseLevel));
    if (pause.mintingPaused) {
      console.log("Governance minting pause is also on.");
    }
    console.log("Do not send XRP or call executeDirectMinting until emergencyPaused() is false.");
    return;
  }

  if (pause.mintingPaused) {
    console.log("Minting is paused (mintingPaused() = true).");
    console.log(
      "Legacy / self-mint paths that check this flag are disabled. Core Vault direct minting follows emergencyPaused() and can proceed while that view is false.",
    );
    return;
  }

  console.log("FAsset system is active (not paused).");
}

void main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
