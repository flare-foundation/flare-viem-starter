export const abi = [
  {
    type: "function",
    name: "getExecutor",
    inputs: [
      {
        name: "_personalAccount",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [
      {
        name: "",
        type: "address",
        internalType: "address",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getNonce",
    inputs: [
      {
        name: "_personalAccount",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "handleMintedFAssets",
    inputs: [
      {
        name: "_transactionId",
        type: "bytes32",
        internalType: "bytes32",
      },
      {
        name: "_sourceAddress",
        type: "string",
        internalType: "string",
      },
      {
        name: "_amount",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "_underlyingTimestamp",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "_memoData",
        type: "bytes",
        internalType: "bytes",
      },
      {
        name: "_executor",
        type: "address",
        internalType: "address payable",
      },
      {
        name: "_data",
        type: "bytes",
        internalType: "bytes",
      },
    ],
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "isTransactionIdUsed",
    inputs: [
      {
        name: "_transactionId",
        type: "bytes32",
        internalType: "bytes32",
      },
    ],
    outputs: [
      {
        name: "",
        type: "bool",
        internalType: "bool",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "event",
    name: "DirectMintingExecuted",
    inputs: [
      {
        name: "personalAccount",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "transactionId",
        type: "bytes32",
        indexed: true,
        internalType: "bytes32",
      },
      {
        name: "sourceAddress",
        type: "string",
        indexed: false,
        internalType: "string",
      },
      {
        name: "amount",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      {
        name: "executorFee",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      {
        name: "executor",
        type: "address",
        indexed: false,
        internalType: "address",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "ExecutorRemoved",
    inputs: [
      {
        name: "personalAccount",
        type: "address",
        indexed: true,
        internalType: "address",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "ExecutorSet",
    inputs: [
      {
        name: "personalAccount",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "executor",
        type: "address",
        indexed: true,
        internalType: "address",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "IgnoreMemoSet",
    inputs: [
      {
        name: "personalAccount",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "targetTxId",
        type: "bytes32",
        indexed: true,
        internalType: "bytes32",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "NonceIncreased",
    inputs: [
      {
        name: "personalAccount",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "newNonce",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "ReplacementFeeSet",
    inputs: [
      {
        name: "personalAccount",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "targetTxId",
        type: "bytes32",
        indexed: true,
        internalType: "bytes32",
      },
      {
        name: "newFee",
        type: "uint64",
        indexed: false,
        internalType: "uint64",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "UserOperationExecuted",
    inputs: [
      {
        name: "personalAccount",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "nonce",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
    ],
    anonymous: false,
  },
  {
    type: "error",
    name: "AddressZero",
    inputs: [],
  },
  {
    type: "error",
    name: "CallFailed",
    inputs: [
      {
        name: "returnData",
        type: "bytes",
        internalType: "bytes",
      },
    ],
  },
  {
    type: "error",
    name: "CustomInstructionHashMismatch",
    inputs: [
      {
        name: "expected",
        type: "bytes32",
        internalType: "bytes32",
      },
      {
        name: "actual",
        type: "bytes32",
        internalType: "bytes32",
      },
    ],
  },
  {
    type: "error",
    name: "InsufficientAmountForFee",
    inputs: [
      {
        name: "amount",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "fee",
        type: "uint256",
        internalType: "uint256",
      },
    ],
  },
  {
    type: "error",
    name: "InvalidInstructionId",
    inputs: [
      {
        name: "instructionId",
        type: "uint8",
        internalType: "uint8",
      },
    ],
  },
  {
    type: "error",
    name: "InvalidMemoData",
    inputs: [],
  },
  {
    type: "error",
    name: "InvalidNonce",
    inputs: [
      {
        name: "expected",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "actual",
        type: "uint256",
        internalType: "uint256",
      },
    ],
  },
  {
    type: "error",
    name: "InvalidNonceIncrease",
    inputs: [
      {
        name: "currentNonce",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "newNonce",
        type: "uint256",
        internalType: "uint256",
      },
    ],
  },
  {
    type: "error",
    name: "InvalidSender",
    inputs: [
      {
        name: "sender",
        type: "address",
        internalType: "address",
      },
      {
        name: "personalAccount",
        type: "address",
        internalType: "address",
      },
    ],
  },
  {
    type: "error",
    name: "OnlyAssetManager",
    inputs: [],
  },
  {
    type: "error",
    name: "TransactionAlreadyExecuted",
    inputs: [],
  },
  {
    type: "error",
    name: "ValueZero",
    inputs: [],
  },
  {
    type: "error",
    name: "WrongExecutor",
    inputs: [
      {
        name: "expected",
        type: "address",
        internalType: "address",
      },
      {
        name: "actual",
        type: "address",
        internalType: "address",
      },
    ],
  },
];
