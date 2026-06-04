import { coston2 } from "@flarenetwork/flare-wagmi-periphery-package";
import { account, publicClient, walletClient } from "../utils/client";
import { getMintingTagManagerAddress } from "../utils/smart-accounts";

async function main() {
  const tag = 72n;
  const recipient = "0x4F2E3d23BdFc554185fd06CC599c98D3A540d60A";
  const sender = account.address;

  const mintingTagManagerAddress = await getMintingTagManagerAddress();
  console.log("MintingTagManager:", mintingTagManagerAddress, "\n");
  console.log("Tag:", tag, "\n");
  console.log("Sender:", sender, "\n");
  console.log("Recipient:", recipient, "\n");

  const [ownerBefore, mintingRecipientBefore] = await Promise.all([
    publicClient.readContract({
      address: mintingTagManagerAddress,
      abi: coston2.iMintingTagManagerAbi,
      functionName: "ownerOf",
      args: [tag],
    }),
    publicClient.readContract({
      address: mintingTagManagerAddress,
      abi: coston2.iMintingTagManagerAbi,
      functionName: "mintingRecipient",
      args: [tag],
    }),
  ]);

  console.log("Owner before:", ownerBefore, "\n");
  console.log("Minting recipient before:", mintingRecipientBefore, "\n");

  if (ownerBefore.toLowerCase() !== sender.toLowerCase()) {
    throw new Error(
      `Tag ${tag} is owned by ${ownerBefore}, but script sender is ${sender}. ` +
        "Run this script with the owner's PRIVATE_KEY."
    );
  }

  // Transfer the minting tag to the recipient
  const { request } = await publicClient.simulateContract({
    account,
    address: mintingTagManagerAddress,
    abi: coston2.iMintingTagManagerAbi,
    functionName: "transferFrom",
    args: [sender, recipient, tag],
  });

  const txHash = await walletClient.writeContract(request);
  console.log("transferFrom tx:", txHash, "\n");
  await publicClient.waitForTransactionReceipt({ hash: txHash });

  const [ownerAfter, mintingRecipientAfter] = await Promise.all([
    publicClient.readContract({
      address: mintingTagManagerAddress,
      abi: coston2.iMintingTagManagerAbi,
      functionName: "ownerOf",
      args: [tag],
    }),
    publicClient.readContract({
      address: mintingTagManagerAddress,
      abi: coston2.iMintingTagManagerAbi,
      functionName: "mintingRecipient",
      args: [tag],
    }),
  ]);

  console.log("Owner after:", ownerAfter, "\n");
  console.log("Minting recipient after:", mintingRecipientAfter, "\n");
}

void main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
