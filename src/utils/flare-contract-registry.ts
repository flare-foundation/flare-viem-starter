import type { Address } from "viem";
import { coston2 } from "@flarenetwork/flare-wagmi-periphery-package";
import { publicClient } from "./client";

const FLARE_CONTRACT_REGISTRY_ADDRESS = "0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019";

export async function getContractAddressByName(name: string): Promise<Address> {
  return publicClient.readContract({
    address: FLARE_CONTRACT_REGISTRY_ADDRESS,
    abi: coston2.iFlareContractRegistryAbi,
    functionName: "getContractAddressByName",
    args: [name],
  });
}

export async function getMasterAccountControllerAddress(): Promise<Address> {
  return getContractAddressByName("MasterAccountController");
}

export async function getAssetManagerFXRPAddress(): Promise<Address> {
  return getContractAddressByName("AssetManagerFXRP");
}

export async function getFxrpAddress(): Promise<Address> {
  const assetManagerAddress = await getAssetManagerFXRPAddress();
  return publicClient.readContract({
    address: assetManagerAddress,
    abi: coston2.iAssetManagerAbi,
    functionName: "fAsset",
  });
}

export async function getDirectMintingPaymentAddress(
  assetManagerAddress: Address,
): Promise<string> {
  const paymentAddress: string = await publicClient.readContract({
    address: assetManagerAddress,
    abi: coston2.iDirectMintingAbi,
    functionName: "directMintingPaymentAddress",
  });
  return paymentAddress;
}

export async function getMintingTagManagerAddress(
  assetManagerAddress: Address,
): Promise<Address> {
  return publicClient.readContract({
    address: assetManagerAddress,
    abi: coston2.iDirectMintingSettingsAbi,
    functionName: "getMintingTagManager",
  });
}
