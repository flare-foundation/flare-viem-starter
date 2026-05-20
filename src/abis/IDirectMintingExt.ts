// Extension ABI for AssetManagerFXRP.executeDirectMintingWithData.
//
// The periphery package (`@flarenetwork/flare-wagmi-periphery-package` 3.4.0)
// exports `iDirectMintingAbi` with `executeDirectMinting(proof)` but does not
// yet include the `WithData` overload required for the 0xFE memo-opcode flow.
// The IXRPPayment.Proof tuple shape mirrors the one already in
// `coston2.ixrpPaymentVerificationAbi` — kept inline here only because viem's
// `as const` ABI typing doesn't compose across imports without losing literal
// inference at the writeContract call site.
//
// Drop this file once the periphery package ships the WithData variant.

const xrpPaymentProofComponents = [
  {
    name: "merkleProof",
    type: "bytes32[]",
    internalType: "bytes32[]",
  },
  {
    name: "data",
    type: "tuple",
    internalType: "struct IXRPPayment.Response",
    components: [
      { name: "attestationType", type: "bytes32", internalType: "bytes32" },
      { name: "sourceId", type: "bytes32", internalType: "bytes32" },
      { name: "votingRound", type: "uint64", internalType: "uint64" },
      { name: "lowestUsedTimestamp", type: "uint64", internalType: "uint64" },
      {
        name: "requestBody",
        type: "tuple",
        internalType: "struct IXRPPayment.RequestBody",
        components: [
          { name: "transactionId", type: "bytes32", internalType: "bytes32" },
          { name: "proofOwner", type: "address", internalType: "address" },
        ],
      },
      {
        name: "responseBody",
        type: "tuple",
        internalType: "struct IXRPPayment.ResponseBody",
        components: [
          { name: "blockNumber", type: "uint64", internalType: "uint64" },
          { name: "blockTimestamp", type: "uint64", internalType: "uint64" },
          { name: "sourceAddress", type: "string", internalType: "string" },
          { name: "sourceAddressHash", type: "bytes32", internalType: "bytes32" },
          { name: "receivingAddressHash", type: "bytes32", internalType: "bytes32" },
          { name: "intendedReceivingAddressHash", type: "bytes32", internalType: "bytes32" },
          { name: "spentAmount", type: "int256", internalType: "int256" },
          { name: "intendedSpentAmount", type: "int256", internalType: "int256" },
          { name: "receivedAmount", type: "int256", internalType: "int256" },
          { name: "intendedReceivedAmount", type: "int256", internalType: "int256" },
          { name: "hasMemoData", type: "bool", internalType: "bool" },
          { name: "firstMemoData", type: "bytes", internalType: "bytes" },
          { name: "hasDestinationTag", type: "bool", internalType: "bool" },
          { name: "destinationTag", type: "uint256", internalType: "uint256" },
          { name: "status", type: "uint8", internalType: "uint8" },
        ],
      },
    ],
  },
] as const;

export const abi = [
  {
    type: "function",
    name: "executeDirectMintingWithData",
    stateMutability: "payable",
    inputs: [
      {
        name: "_payment",
        type: "tuple",
        internalType: "struct IXRPPayment.Proof",
        components: xrpPaymentProofComponents,
      },
      { name: "_data", type: "bytes", internalType: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "event",
    name: "DirectMintingExecutedToSmartAccount",
    anonymous: false,
    inputs: [
      { name: "transactionId", type: "bytes32", indexed: false, internalType: "bytes32" },
      { name: "sourceAddress", type: "string", indexed: false, internalType: "string" },
      { name: "executor", type: "address", indexed: false, internalType: "address" },
      { name: "mintedAmountUBA", type: "uint256", indexed: false, internalType: "uint256" },
      { name: "mintingFeeUBA", type: "uint256", indexed: false, internalType: "uint256" },
      { name: "memoData", type: "bytes", indexed: false, internalType: "bytes" },
    ],
  },
  {
    type: "event",
    name: "DirectMintingDelayed",
    anonymous: false,
    inputs: [
      { name: "transactionId", type: "bytes32", indexed: false, internalType: "bytes32" },
      { name: "amount", type: "uint256", indexed: false, internalType: "uint256" },
      { name: "executionAllowedAt", type: "uint256", indexed: false, internalType: "uint256" },
    ],
  },
] as const;
