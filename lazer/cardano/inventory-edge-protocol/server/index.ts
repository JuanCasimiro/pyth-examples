/**
 * Local judge demo API: signs with CARDANO_MNEMONIC from `.env` (PreProd only).
 * Run with `npm run dev:api` from repo root; UI proxies `/api` in dev.
 */
import "dotenv/config";

import * as Address from "@evolution-sdk/evolution/Address";
import * as AssetName from "@evolution-sdk/evolution/AssetName";
import * as PolicyId from "@evolution-sdk/evolution/PolicyId";
import cors from "cors";
import express from "express";

import {
  loadBlueprint,
  liquidityPoolSpendValidator,
  vaultSpendValidator,
} from "../lib/blueprint.js";
import {
  DEMO_SLOT_LABEL,
  DEMO_SLOT_TO_KEY,
  LAZER_FEED_BY_KEY,
  quoteChainForDemoSlot,
  quoteChainForVaultFeedId,
  type DemoSlot,
  type ShadowAssetKey,
  PYTH_LAZER_FEEDS,
} from "../lib/feeds.js";
import {
  listWalletNativeNfts,
  listWalletShadowNfts,
} from "../lib/wallet_shadow_nfts.js";
import { mintShadowNft } from "../lib/mint_shadow.js";
import { PYTH_POLICY_ID_HEX } from "../lib/pyth.js";
import {
  fetchFeedQuoteResolved,
  fetchFeedQuotes,
  isUnderwater,
  minCollateralQtyForDebt,
  suggestedCollateralQtyForDebt,
} from "../lib/pyth_quotes.js";
import {
  adjustDebt,
  applyHedge,
  claimInsurance,
  closeVault,
  getVaultUtxoByRef,
  liquidate,
  listVaultPositions,
  openVault,
  readInlineDatum,
} from "../lib/transactions.js";
import {
  decodeVaultDatum,
  type DecodedVaultDatum,
} from "../lib/vault_datum_decode.js";
import { enterpriseVaultAddress } from "../lib/vault_address.js";

import {
  createPreprodSigningClient,
  preprodChainBackendLabel,
} from "../lib/evolution_client.js";
import {
  depositLiquidityPoolOnChain,
  listPoolDepositsOnChain,
  liquidityPoolAddressBech32,
  poolDepositReserveLovelace,
  walletTotalLovelaceLucid,
  withdrawAllLiquidityPoolOnChain,
} from "../lib/pool_onchain.js";
import {
  appendAudit,
  loadPool,
  LOAN_REPAY_INTEREST_BPS,
  poolCancelReservation,
  poolCommitLoan,
  poolDeposit,
  poolEffectiveAvailableForInsuranceReserve,
  poolFinalizeCloseVault,
  poolOnDebtAdjusted,
  poolOnLiquidateLoan,
  poolReleaseOnClaim,
  poolReserveForHedge,
  poolWithdraw,
  readAudit,
} from "../lib/judge_store.js";

const PORT = Number(process.env.JUDGE_API_PORT ?? 8787);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function findVaultRefByNft(
  policyHex: string,
  nameHex: string,
): Promise<string | null> {
  const rows = await listVaultPositions();
  const p = policyHex.toLowerCase();
  const n = nameHex.toLowerCase();
  const hit = rows.find(
    (r) =>
      r.datum.nftPolicyHex.toLowerCase() === p &&
      r.datum.nftNameHex.toLowerCase() === n,
  );
  return hit?.ref ?? null;
}

async function findVaultRefByNftWithRetry(
  policyHex: string,
  nameHex: string,
): Promise<string | null> {
  await sleep(2000);
  for (let attempt = 0; attempt < 5; attempt++) {
    const ref = await findVaultRefByNft(policyHex, nameHex);
    if (ref) return ref;
    await sleep(1500);
  }
  return null;
}

function requireMnemonic(): string {
  const m = process.env.CARDANO_MNEMONIC;
  if (!m) throw new Error("CARDANO_MNEMONIC not set");
  return m;
}

function jsonDatum(d: DecodedVaultDatum) {
  return {
    ownerKeyHashHex: d.ownerKeyHashHex,
    pythPolicyHex: d.pythPolicyHex,
    nftPolicyHex: d.nftPolicyHex,
    nftNameHex: d.nftNameHex,
    debtLovelace: d.debtLovelace.toString(),
    collateralQty: d.collateralQty.toString(),
    feedId: d.feedId.toString(),
    hedge:
      d.hedge.tag === "none"
        ? null
        : {
            strikeRaw: d.hedge.strikeRaw.toString(),
            payoutLovelace: d.hedge.payoutLovelace.toString(),
          },
  };
}

function parseSlot(s: string): DemoSlot {
  if (s === "metal" || s === "oil" || s === "stock") return s;
  throw new Error('slot must be "metal", "oil", or "stock"');
}

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: "512kb" }));

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    preprod: true,
    hasMnemonic: Boolean(process.env.CARDANO_MNEMONIC),
    hasAccessToken: Boolean(process.env.ACCESS_TOKEN),
    hasBlockfrostOrMaestro: Boolean(
      process.env.BLOCKFROST_PROJECT_ID ?? process.env.MAESTRO_API_KEY,
    ),
    /** Evolution (vault txs) usa este backend para evaluar scripts; Koios/ogmios público suele fallar. */
    evolutionChainBackend: preprodChainBackendLabel(),
  });
});

app.get("/api/config", (_req, res) => {
  try {
    const bp = loadBlueprint();
    const val = vaultSpendValidator(bp);
    const vaultAddr = enterpriseVaultAddress(val.hash);
    const poolVal = liquidityPoolSpendValidator(bp);
    const poolAddr = enterpriseVaultAddress(poolVal.hash);
    res.json({
      network: "preprod",
      vaultScriptHash: val.hash,
      vaultAddressBech32: Address.toBech32(vaultAddr),
      liquidityPoolScriptHash: poolVal.hash,
      liquidityPoolAddressBech32: Address.toBech32(poolAddr),
      poolDepositReserveLovelace: poolDepositReserveLovelace().toString(),
      pythPolicyIdHex: PYTH_POLICY_ID_HEX,
      feeds: PYTH_LAZER_FEEDS,
      demoSlots: DEMO_SLOT_LABEL,
      slotToFeedKey: DEMO_SLOT_TO_KEY,
      formulas: {
        liquidateWhen:
          "price * collateralQty * 100 < debtLovelace * 110 (same units as on-chain Pyth price)",
        claimInsuranceWhen: "hedge active and price < strike_raw",
      },
    });
  } catch (e) {
    res.status(500).json({
      error: e instanceof Error ? e.message : String(e),
    });
  }
});

app.get("/api/wallet", async (_req, res) => {
  try {
    const mnemonic = requireMnemonic();
    const client = createPreprodSigningClient(mnemonic);
    const addr = await client.address();
    const utxos = await client.getWalletUtxos();
    let lovelace = 0n;
    const nfts: { unit: string; quantity: string }[] = [];
    for (const u of utxos) {
      lovelace += u.assets.lovelace;
      const m = u.assets.multiAsset;
      if (!m) continue;
      for (const [pid, inner] of m.map) {
        const ph = PolicyId.toHex(pid);
        for (const [aname, qty] of inner) {
          if (qty > 0n) {
            nfts.push({
              unit: ph + AssetName.toHex(aname),
              quantity: qty.toString(),
            });
          }
        }
      }
    }
    const shadows = await listWalletShadowNfts(mnemonic);
    const native = await listWalletNativeNfts(mnemonic);
    res.json({
      address: Address.toBech32(addr),
      lucidAddress: shadows.address,
      lovelace: lovelace.toString(),
      adaApprox: (Number(lovelace) / 1e6).toFixed(6),
      nftCount: nfts.length,
      nfts,
      nativeNfts: native.nfts,
      shadowNfts: shadows.nfts,
    });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.get("/api/pyth/demo-feeds", async (_req, res) => {
  try {
    const slots: DemoSlot[] = ["metal", "oil", "stock"];
    const rows = [];
    for (const slot of slots) {
      const key = DEMO_SLOT_TO_KEY[slot] as ShadowAssetKey;
      const m = LAZER_FEED_BY_KEY[key];
      const chain = quoteChainForDemoSlot(slot);
      const quote = await fetchFeedQuoteResolved(chain);
      const marketOpen = Boolean(quote.priceRaw);
      rows.push({
        slot,
        key,
        feedId: m.id,
        proSymbol: m.proSymbol,
        uiTitle: m.uiTitle,
        lazerChannel: m.channel,
        label: DEMO_SLOT_LABEL[slot].title,
        quote,
        proSymbolUsed:
          quote.resolvedProSymbol ??
          (quote.priceRaw ? m.proSymbol : undefined),
        quoteNote: quote.quoteNote,
        marketOpen,
        marketLabel: marketOpen ? "Mercado abierto" : "Mercado cerrado",
      });
    }
    res.json({
      asOf: Date.now(),
      docsUrl:
        "https://docs.pyth.network/price-feeds/pro/price-feed-ids",
      rows,
    });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.get("/api/audit", (req, res) => {
  const lim = Number(req.query.limit ?? 100);
  const limit = Number.isFinite(lim)
    ? Math.min(400, Math.max(1, Math.floor(lim)))
    : 100;
  res.json({ events: readAudit(limit) });
});

app.get("/api/mock/pool", (_req, res) => {
  try {
    res.json(loadPool());
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.post("/api/mock/pool/deposit", (req, res) => {
  try {
    const raw = req.body?.lovelace;
    if (raw == null) {
      res.status(400).json({ error: "lovelace required" });
      return;
    }
    const lovelace = BigInt(String(raw));
    if (lovelace <= 0n) {
      res.status(400).json({ error: "lovelace must be positive" });
      return;
    }
    const p = poolDeposit(lovelace);
    appendAudit({
      kind: "mock_pool_deposit",
      summary: `Depósito demo al pool de seguros: ${lovelace} lovelace`,
      extra: { lovelace: lovelace.toString() },
    });
    res.json(p);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

/**
 * Suma al pool mock un % del lovelace total que ve la wallet (Evolution).
 * No construye ni envía tx: no mueve ADA on-chain.
 */
app.post("/api/mock/pool/deposit-wallet-percent", async (req, res) => {
  try {
    const pct = Number(req.body?.percent ?? 80);
    if (!Number.isFinite(pct) || pct < 1 || pct > 100 || Math.floor(pct) !== pct) {
      res.status(400).json({ error: "percent debe ser entero entre 1 y 100" });
      return;
    }
    const mnemonic = requireMnemonic();
    const client = createPreprodSigningClient(mnemonic);
    const utxos = await client.getWalletUtxos();
    let total = 0n;
    for (const u of utxos) {
      total += u.assets.lovelace;
    }
    if (total <= 0n) {
      res.status(400).json({
        error: "La wallet no tiene lovelace según el proveedor (Evolution).",
      });
      return;
    }
    const amount = (total * BigInt(pct)) / 100n;
    if (amount <= 0n) {
      res.status(400).json({
        error: `Con saldo ${total} lovelace, el ${pct}% redondea a 0. Aumentá el saldo o usá depósito manual.`,
        walletLovelace: total.toString(),
      });
      return;
    }
    const p = poolDeposit(amount);
    appendAudit({
      kind: "mock_pool_deposit_wallet_pct",
      summary: `Pool mock +${amount} lovelace (${pct}% de wallet ${total})`,
      extra: {
        percent: pct,
        walletLovelace: total.toString(),
        depositedLovelace: amount.toString(),
      },
    });
    res.json({
      pool: p,
      walletLovelace: total.toString(),
      depositedLovelace: amount.toString(),
      percent: pct,
      note: "Solo contabilidad en data/mock_insurance_pool.json — no se firmó ninguna transacción Cardano.",
    });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

/** Depósito real al script `liquidity_pool` + sincroniza el pool mock. */
app.post("/api/pool/onchain/deposit-percent", async (req, res) => {
  try {
    const pct = Number(req.body?.percent ?? 80);
    if (!Number.isFinite(pct) || pct < 1 || pct > 100 || Math.floor(pct) !== pct) {
      res.status(400).json({ error: "percent debe ser entero entre 1 y 100" });
      return;
    }
    const total = await walletTotalLovelaceLucid();
    if (total <= 0n) {
      res.status(400).json({ error: "Wallet sin lovelace (Lucid)" });
      return;
    }
    const reserve = poolDepositReserveLovelace();
    const amount = (total * BigInt(pct)) / 100n;
    if (amount <= 0n) {
      res.status(400).json({
        error: `El ${pct}% redondea a 0.`,
        walletLovelace: total.toString(),
      });
      return;
    }
    if (amount + reserve > total) {
      res.status(400).json({
        error:
          `Saldo ${total} lovelace: el ${pct}% son ${amount}; necesitás ~${reserve} extra para fees. Bajá el % o POOL_DEPOSIT_RESERVE_LOVELACE.`,
        walletLovelace: total.toString(),
        requestedLovelace: amount.toString(),
        reserveLovelace: reserve.toString(),
      });
      return;
    }
    const txHash = await depositLiquidityPoolOnChain({ lovelace: amount });
    const p = poolDeposit(amount);
    appendAudit({
      kind: "pool_onchain_deposit_pct",
      summary: `Pool on-chain +${amount} lovelace (${pct}% wallet)`,
      txHash,
      extra: {
        percent: pct,
        walletLovelace: total.toString(),
        depositedLovelace: amount.toString(),
      },
    });
    res.json({
      txHash,
      pool: p,
      walletLovelace: total.toString(),
      depositedLovelace: amount.toString(),
      percent: pct,
      liquidityPoolAddressBech32: liquidityPoolAddressBech32(),
    });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.post("/api/pool/onchain/deposit", async (req, res) => {
  try {
    const raw = req.body?.lovelace;
    if (raw == null) {
      res.status(400).json({ error: "lovelace required" });
      return;
    }
    const amount = BigInt(String(raw));
    if (amount <= 0n) {
      res.status(400).json({ error: "lovelace must be positive" });
      return;
    }
    const txHash = await depositLiquidityPoolOnChain({ lovelace: amount });
    const p = poolDeposit(amount);
    appendAudit({
      kind: "pool_onchain_deposit",
      summary: `Pool on-chain +${amount} lovelace`,
      txHash,
      extra: { depositedLovelace: amount.toString() },
    });
    res.json({
      txHash,
      pool: p,
      depositedLovelace: amount.toString(),
      liquidityPoolAddressBech32: liquidityPoolAddressBech32(),
    });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.get("/api/pool/onchain/positions", async (_req, res) => {
  try {
    const positions = await listPoolDepositsOnChain();
    const total = positions.reduce((a, r) => a + BigInt(r.lovelace), 0n);
    res.json({
      positions,
      totalLovelace: total.toString(),
      liquidityPoolAddressBech32: liquidityPoolAddressBech32(),
    });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

/** Gasta todos los UTxOs del pool con tu owner en datum; sincroniza pool mock. */
app.post("/api/pool/onchain/withdraw-all", async (_req, res) => {
  try {
    const { txHash, withdrawnLovelace, inputCount } =
      await withdrawAllLiquidityPoolOnChain();
    const p = poolWithdraw(BigInt(withdrawnLovelace));
    appendAudit({
      kind: "pool_onchain_withdraw_all",
      summary: `Pool on-chain retiro ${withdrawnLovelace} lovelace (${inputCount} inputs)`,
      txHash,
      extra: { withdrawnLovelace, inputCount },
    });
    res.json({
      txHash,
      withdrawnLovelace,
      inputCount,
      pool: p,
      liquidityPoolAddressBech32: liquidityPoolAddressBech32(),
    });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.post("/api/mint", async (req, res) => {
  try {
    const slot = parseSlot(String(req.body?.slot ?? ""));
    const out = await mintShadowNft(slot);
    appendAudit({
      kind: "mint_shadow",
      summary: `Mint NFT sombra (${out.slot}) · ${out.assetName}`,
      txHash: out.txHash,
      extra: { feedId: out.feedId, policyId: out.policyId },
    });
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.get("/api/vaults", async (_req, res) => {
  try {
    const rows = await listVaultPositions();
    res.json({
      vaults: rows.map((r) => ({
        ref: r.ref,
        txHash: r.txHash,
        outputIndex: r.outputIndex,
        lovelace: r.lovelace,
        datum: jsonDatum(r.datum),
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.post("/api/vault/open", async (req, res) => {
  try {
    const {
      nftPolicyHex,
      nftNameHex,
      feedId,
      debtLovelace,
      collateralQty,
    } = req.body ?? {};
    if (!nftPolicyHex || !nftNameHex || feedId == null) {
      res.status(400).json({ error: "nftPolicyHex, nftNameHex, feedId required" });
      return;
    }
    const pol = String(nftPolicyHex);
    const nm = String(nftNameHex);
    const loan = BigInt(debtLovelace ?? "0");
    if (loan > 0n) {
      const av = BigInt(loadPool().availableLovelace);
      if (av < loan) {
        res.status(400).json({
          error:
            `El pool no tiene tADA suficientes para financiar este préstamo. Disponible: ${av} lovelace; solicitado: ${loan}. Depositá liquidez mock en la pestaña Seguros.`,
          code: "POOL_INSUFFICIENT_FUNDS",
          availableLovelace: av.toString(),
          requestedLovelace: loan.toString(),
        });
        return;
      }
    }
    const txHash = await openVault({
      nftPolicyHex: pol,
      nftNameHex: nm,
      feedId: Number(feedId),
      debtLovelace: loan,
      collateralQty: BigInt(collateralQty ?? "1"),
    });
    if (loan > 0n) {
      poolCommitLoan({
        nftPolicyHex: pol,
        nftNameHex: nm,
        loanLovelace: loan,
      });
    }
    appendAudit({
      kind: "vault_open",
      summary:
        loan > 0n
          ? `openVault: préstamo desde pool ${loan} lovelace · feed_id=${feedId}`
          : `openVault colateral-only (principal 0) · feed_id=${feedId}`,
      txHash,
      extra: {
        nftPolicyHex: pol,
        nftNameHex: nm,
        feedId: Number(feedId),
        loanLovelace: loan.toString(),
      },
    });
    res.json({ txHash });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.post("/api/vault/hedge", async (req, res) => {
  try {
    const { txHash, outputIndex, strikeRaw, payoutLovelace } = req.body ?? {};
    if (txHash == null || outputIndex == null) {
      res.status(400).json({ error: "txHash and outputIndex required" });
      return;
    }
    const u = await getVaultUtxoByRef(String(txHash), Number(outputIndex));
    const decoded = decodeVaultDatum(readInlineDatum(u));
    const payoutReq = BigInt(payoutLovelace ?? "0");
    if (payoutReq > 0n) {
      const eff = poolEffectiveAvailableForInsuranceReserve(
        decoded.nftPolicyHex,
        decoded.nftNameHex,
      );
      if (eff < payoutReq) {
        res.status(400).json({
          error:
            `El pool no puede respaldar este payout (${payoutReq} lovelace). Liquidez efectiva para esta cobertura: ${eff}. Aportá más tADA mock o bajá el payout.`,
          code: "POOL_INSUFFICIENT_FUNDS",
          requestedLovelace: payoutReq.toString(),
          effectiveAvailableLovelace: eff.toString(),
        });
        return;
      }
    }
    const h = await applyHedge({
      vaultUtxo: u,
      strikeRaw: BigInt(strikeRaw ?? "0"),
      payoutLovelace: payoutReq,
    });
    appendAudit({
      kind: "vault_hedge",
      summary: `applyHedge strike=${strikeRaw} payout=${payoutLovelace}`,
      txHash: h,
      extra: {
        nftPolicyHex: decoded.nftPolicyHex,
        nftNameHex: decoded.nftNameHex,
      },
    });
    const nextRef = await findVaultRefByNftWithRetry(
      decoded.nftPolicyHex,
      decoded.nftNameHex,
    );
    if (nextRef) {
      const { reserved, shortfall } = poolReserveForHedge({
        nftPolicyHex: decoded.nftPolicyHex,
        nftNameHex: decoded.nftNameHex,
        vaultRef: nextRef,
        payoutRequested: payoutReq,
      });
      appendAudit({
        kind: "mock_pool_reserve",
        summary:
          shortfall > 0n
            ? `Pool: apartado ${reserved} lovelace; shortfall ${shortfall} (inconsistencia — revisar)`
            : `Pool: apartado ${reserved} lovelace para cobertura`,
        txHash: h,
        extra: {
          vaultRef: nextRef,
          reserved: reserved.toString(),
          shortfall: shortfall.toString(),
        },
      });
    } else {
      appendAudit({
        kind: "mock_pool_reserve_skipped",
        summary:
          "Pool mock: no se encontró la vault tras hedge (indexador); reintentá o reservá tras refrescar.",
        txHash: h,
      });
    }
    res.json({ txHash: h, poolVaultRef: nextRef });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.post("/api/vault/adjust", async (req, res) => {
  try {
    const { txHash, outputIndex, newDebtLovelace } = req.body ?? {};
    if (txHash == null || outputIndex == null || newDebtLovelace == null) {
      res
        .status(400)
        .json({ error: "txHash, outputIndex, newDebtLovelace required" });
      return;
    }
    const u = await getVaultUtxoByRef(String(txHash), Number(outputIndex));
    const prev = decodeVaultDatum(readInlineDatum(u));
    const oldD = prev.debtLovelace;
    const newD = BigInt(newDebtLovelace);
    if (newD > oldD) {
      const need = newD - oldD;
      const av = BigInt(loadPool().availableLovelace);
      if (av < need) {
        res.status(400).json({
          error:
            `El pool no tiene tADA para aumentar el préstamo en ${need} lovelace. Disponible: ${av}.`,
          code: "POOL_INSUFFICIENT_FUNDS",
          availableLovelace: av.toString(),
          requestedLovelace: need.toString(),
        });
        return;
      }
    }
    const h = await adjustDebt({
      vaultUtxo: u,
      newDebtLovelace: newD,
    });
    poolOnDebtAdjusted({
      nftPolicyHex: prev.nftPolicyHex,
      nftNameHex: prev.nftNameHex,
      oldDebtLovelace: oldD,
      newDebtLovelace: newD,
    });
    appendAudit({
      kind: "vault_adjust",
      summary: `adjustDebt ${oldD.toString()} → ${newD.toString()} (interés demo al amortizar: ${LOAN_REPAY_INTEREST_BPS} bps del principal devuelto)`,
      txHash: h,
    });
    res.json({ txHash: h });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.post("/api/vault/close", async (req, res) => {
  try {
    const { txHash, outputIndex } = req.body ?? {};
    if (txHash == null || outputIndex == null) {
      res.status(400).json({ error: "txHash and outputIndex required" });
      return;
    }
    const u = await getVaultUtxoByRef(String(txHash), Number(outputIndex));
    const decoded = decodeVaultDatum(readInlineDatum(u));
    const h = await closeVault({ vaultUtxo: u });
    if (decoded.hedge.tag === "some") {
      poolCancelReservation({
        nftPolicyHex: decoded.nftPolicyHex,
        nftNameHex: decoded.nftNameHex,
      });
    }
    poolFinalizeCloseVault({
      nftPolicyHex: decoded.nftPolicyHex,
      nftNameHex: decoded.nftNameHex,
    });
    appendAudit({
      kind: "vault_close",
      summary: "closeVault (debt=0)",
      txHash: h,
      extra: {
        nftPolicyHex: decoded.nftPolicyHex,
        nftNameHex: decoded.nftNameHex,
      },
    });
    res.json({ txHash: h });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.post("/api/vault/liquidate", async (req, res) => {
  try {
    const { txHash, outputIndex, priceFeedId } = req.body ?? {};
    if (txHash == null || outputIndex == null || priceFeedId == null) {
      res
        .status(400)
        .json({ error: "txHash, outputIndex, priceFeedId required" });
      return;
    }
    const u = await getVaultUtxoByRef(String(txHash), Number(outputIndex));
    const decoded = decodeVaultDatum(readInlineDatum(u));
    const h = await liquidate({
      vaultUtxo: u,
      priceFeedId: Number(priceFeedId),
    });
    poolCancelReservation({
      nftPolicyHex: decoded.nftPolicyHex,
      nftNameHex: decoded.nftNameHex,
    });
    poolOnLiquidateLoan({
      nftPolicyHex: decoded.nftPolicyHex,
      nftNameHex: decoded.nftNameHex,
      debtLovelace: decoded.debtLovelace,
    });
    appendAudit({
      kind: "vault_liquidate",
      summary: `liquidate (venta simulada de colateral → pool) · deuda ${decoded.debtLovelace.toString()} · feed ${priceFeedId}`,
      txHash: h,
      extra: {
        nftPolicyHex: decoded.nftPolicyHex,
        nftNameHex: decoded.nftNameHex,
      },
    });
    res.json({ txHash: h });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.post("/api/vault/claim", async (req, res) => {
  try {
    const { txHash, outputIndex, priceFeedId } = req.body ?? {};
    if (txHash == null || outputIndex == null || priceFeedId == null) {
      res
        .status(400)
        .json({ error: "txHash, outputIndex, priceFeedId required" });
      return;
    }
    const u = await getVaultUtxoByRef(String(txHash), Number(outputIndex));
    const decoded = decodeVaultDatum(readInlineDatum(u));
    const h = await claimInsurance({
      vaultUtxo: u,
      priceFeedId: Number(priceFeedId),
    });
    const rel = poolReleaseOnClaim({
      nftPolicyHex: decoded.nftPolicyHex,
      nftNameHex: decoded.nftNameHex,
    });
    appendAudit({
      kind: "vault_claim",
      summary: rel.found
        ? `claimInsurance: pago simulado ${rel.paidOut} lovelace; fee pool ${rel.poolFee}`
        : "claimInsurance (sin reserva previa en pool mock)",
      txHash: h,
      extra: {
        nftPolicyHex: decoded.nftPolicyHex,
        nftNameHex: decoded.nftNameHex,
        poolReleased: rel.released.toString(),
        poolFee: rel.poolFee.toString(),
        poolFound: rel.found,
      },
    });
    res.json({ txHash: h });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.get("/api/pyth/quotes", async (req, res) => {
  try {
    const raw = String(req.query.ids ?? "");
    const ids = raw
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean)
      .map((x) => Number(x));
    const quotes = await fetchFeedQuotes(ids);
    res.json({ quotes });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

/**
 * `collateral_qty` mínimo y sugerido (con 25% colchón) alineados a `vault.ak` Liquidate:
 * `priceRaw * qty * 100 >= debtLovelace * 110`.
 */
app.get("/api/pyth/collateral-hint", async (req, res) => {
  try {
    const feedId = Number(req.query.feedId ?? "");
    const debtLovelace = BigInt(String(req.query.debtLovelace ?? "0"));
    if (!Number.isFinite(feedId) || feedId <= 0) {
      res.status(400).json({ error: "feedId query required (positive number)" });
      return;
    }
    const chain = quoteChainForVaultFeedId(feedId);
    const q = await fetchFeedQuoteResolved(chain);
    if (!q.priceRaw) {
      res.json({
        quote: q,
        minCollateralQty: null,
        suggestedCollateralQty: null,
        note:
          q.quoteNote ??
          "Sin precio Pyth en esta cadena — no se puede derivar colateral.",
      });
      return;
    }
    const priceRaw = BigInt(q.priceRaw);
    const minCollateralQty = minCollateralQtyForDebt(
      debtLovelace,
      priceRaw,
    ).toString();
    const suggestedCollateralQty = suggestedCollateralQtyForDebt(
      debtLovelace,
      priceRaw,
    ).toString();
    res.json({
      quote: q,
      minCollateralQty,
      suggestedCollateralQty,
      debtLovelace: debtLovelace.toString(),
      formula:
        "Liquidación si price×qty×100 < debt×110. min qty = ceil(debt×110/(price×100)); sugerido = min + 25% buffer.",
    });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.get("/api/risk", async (req, res) => {
  try {
    const txHash = String(req.query.txHash ?? "");
    const outputIndex = Number(req.query.outputIndex ?? "");
    if (!txHash || Number.isNaN(outputIndex)) {
      res.status(400).json({ error: "txHash and outputIndex query required" });
      return;
    }
    const u = await getVaultUtxoByRef(txHash, outputIndex);
    const datum = decodeVaultDatum(readInlineDatum(u));
    const feedId = Number(datum.feedId);
    const chain = quoteChainForVaultFeedId(feedId);
    const q = await fetchFeedQuoteResolved(chain);
    let underwater = false;
    let claimEligible = false;
    let note = q.quoteNote ?? "";
    if (q.priceRaw) {
      const priceRaw = BigInt(q.priceRaw);
      underwater = isUnderwater({
        priceRaw,
        collateralQty: datum.collateralQty,
        debtLovelace: datum.debtLovelace,
      });
      if (datum.hedge.tag === "some") {
        claimEligible = priceRaw < datum.hedge.strikeRaw;
      }
      if (q.priceFeedId !== feedId) {
        note =
          (note ? `${note} ` : "") +
          `Precio mostrado es del feed ${q.priceFeedId} (${q.resolvedProSymbol ?? "?"}); el datum usa feed_id ${feedId} — on-chain el testigo Pyth debe coincidir con ese id para liquidar.`;
      }
    } else if (!note) {
      note =
        "Mercado cerrado o sin publicadores en esta cadena de feeds — no es un error de la aplicación.";
    }
    const marketOpen = Boolean(q.priceRaw);
    const loanPoolNote =
      `On-chain: el validador compara precio×colateral vs principal en datum. ` +
      `Intereses: demo off-chain (${LOAN_REPAY_INTEREST_BPS} bps sobre lo amortizado) van al pool al bajar la deuda.`;
    res.json({
      ref: `${txHash}#${outputIndex}`,
      feedId,
      quote: q,
      underwater,
      claimEligible,
      debtLovelace: datum.debtLovelace.toString(),
      collateralQty: datum.collateralQty.toString(),
      hedge: jsonDatum(datum).hedge,
      note,
      loanPoolNote,
      marketOpen,
      marketLabel: marketOpen ? "Mercado abierto" : "Mercado cerrado",
      marketHint: marketOpen
        ? undefined
        : "Sin precio en este momento. Suele deberse a mercado cerrado o a la ausencia temporal de publicadores.",
    });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.use(
  (
    err: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    console.error(err);
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  },
);

app.listen(PORT, () => {
  console.log(`Judge API http://127.0.0.1:${PORT}`);
});
