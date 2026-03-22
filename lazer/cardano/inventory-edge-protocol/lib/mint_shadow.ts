/**
 * Mint one native shadow NFT (Lucid) — unique asset name so judges can repeat demos.
 */
import { randomBytes } from "node:crypto";

import { Blockfrost, Lucid, Maestro } from "lucid-cardano";

import {
  DEMO_SLOT_TO_KEY,
  type DemoSlot,
  PYTH_LAZER_FEEDS,
  SHADOW_ASSETS,
} from "./feeds.js";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

/** Shared Lucid instance (Blockfrost/Maestro) — same UTxO view as mint. */
export async function newLucidPreprod(): Promise<Lucid> {
  const projectId = process.env.BLOCKFROST_PROJECT_ID;
  const maestroKey = process.env.MAESTRO_API_KEY;
  if (projectId) {
    return await Lucid.new(
      new Blockfrost("https://cardano-preprod.blockfrost.io/api/v0", projectId),
      "Preprod",
    );
  }
  if (maestroKey) {
    return await Lucid.new(
      new Maestro({ network: "Preprod", apiKey: maestroKey }),
      "Preprod",
    );
  }
  throw new Error("Set BLOCKFROST_PROJECT_ID or MAESTRO_API_KEY (Preprod)");
}

export type MintShadowResult = {
  txHash: string;
  policyId: string;
  assetName: string;
  nameHex: string;
  slot: DemoSlot;
  assetKey: keyof typeof PYTH_LAZER_FEEDS;
  feedId: number;
};

export async function mintShadowNft(slot: DemoSlot): Promise<MintShadowResult> {
  const mnemonic = requireEnv("CARDANO_MNEMONIC");
  const lucid = await newLucidPreprod();
  lucid.selectWalletFromSeed(mnemonic);

  const addr = await lucid.wallet.address();
  const details = lucid.utils.getAddressDetails(addr);
  if (details.paymentCredential?.type !== "Key") {
    throw new Error("Expected key payment credential");
  }

  const key = DEMO_SLOT_TO_KEY[slot];
  const suffix = randomBytes(4).toString("hex");
  const assetName = `Shadow${key}_${suffix}`;
  const nameHex = Buffer.from(assetName, "utf8").toString("hex");

  const mintingPolicy = lucid.utils.nativeScriptFromJson({
    type: "all",
    scripts: [{ type: "sig", keyHash: details.paymentCredential.hash }],
  });
  const policyId = lucid.utils.mintingPolicyToId(mintingPolicy);
  const unit = policyId + nameHex;

  const meta = SHADOW_ASSETS[key];
  const tx = await lucid
    .newTx()
    .mintAssets({ [unit]: 1n })
    .attachMintingPolicy(mintingPolicy)
    .attachMetadata(721, {
      [policyId]: {
        [assetName]: {
          name: meta.label,
          description: meta.description,
          pyth_lazer_feed_id: String(PYTH_LAZER_FEEDS[key]),
          inventory_edge_class: key,
          inventory_edge_slot: slot,
        },
      },
    })
    .complete();

  const signed = await tx.sign().complete();
  const txHash = await signed.submit();

  return {
    txHash,
    policyId,
    assetName,
    nameHex,
    slot,
    assetKey: key,
    feedId: PYTH_LAZER_FEEDS[key],
  };
}
