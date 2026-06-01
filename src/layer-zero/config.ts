import { EndpointId } from "@layerzerolabs/lz-definitions";
import type { Address } from "viem";

export const config = {
  // FXRP OFT on Sepolia. Required - set via the SEPOLIA_FXRP_OFT env var (no default).
  SEPOLIA_FXRP_OFT: process.env.SEPOLIA_FXRP_OFT as Address | undefined,
  // Coston2 OFT Adapter for the FXRP -> Sepolia route. Exposes the LayerZero
  // IOFT interface (send / quoteSend) directly - driven both by the direct
  // bridge script and by the 0xFE mint flow (no memo-cap shim needed).
  COSTON2_OFT_ADAPTER: "0xCd3d2127935Ae82Af54Fc31cCD9D3440dbF46639" as Address,
  // FAsset redeem composer on Coston2 (the auto-redeem destination).
  COSTON2_COMPOSER: (process.env.COSTON2_COMPOSER ?? "0xa10569DFb38FE7Be211aCe4E4A566Cea387023b0") as Address,
  // Thin shim that resolves the FXRP token on-chain and bridges in one call (memo-field mint flow).
  FXRP_LZ_BRIDGE_SHIM: (process.env.FXRP_LZ_BRIDGE_SHIM ?? "0x525CCe1C6d053B0e7f41A2011B536aA992200Be0") as Address,
  COSTON2_EID: EndpointId.FLARE_V2_TESTNET,
  SEPOLIA_EID: EndpointId.SEPOLIA_V2_TESTNET,
  // lzReceive gas for a plain OFT send to Sepolia (mint + bridge).
  EXECUTOR_GAS: 200_000,
  // Heavier lzReceive + compose gas for the redeem path (send to Coston2, then compose).
  REDEEM_EXECUTOR_GAS: 1_000_000,
  COMPOSE_GAS: 1_000_000,
} as const;
