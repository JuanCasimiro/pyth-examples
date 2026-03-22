/**
 * Pool de liquidez mock (off-chain): préstamos, reservas de seguro, beneficios.
 * El datum on-chain sigue usando debt_lovelace; el pool demo financia y contabiliza.
 */
import fs from "node:fs";
import path from "node:path";

const DATA_DIR = path.join(process.cwd(), "data");
const AUDIT_PATH = path.join(DATA_DIR, "judge_audit.json");
const POOL_PATH = path.join(DATA_DIR, "mock_insurance_pool.json");
const MAX_AUDIT = 400;

/** Interés demo sobre cada amortización de principal (bps). */
export const LOAN_REPAY_INTEREST_BPS = 100n;
/** Excedente simulado de venta de colateral: % del principal que ingresa al pool. */
export const LIQUIDATION_POOL_SURPLUS_BPS = 800n;
/** Fee mock que el pool retiene al pagar una cobertura (bps del monto reservado). */
export const INSURANCE_POOL_FEE_BPS = 300n;

export type AuditEvent = {
  ts: string;
  kind: string;
  summary: string;
  txHash?: string;
  extra?: Record<string, string | number | boolean | null>;
};

export type PoolReservation = {
  nftPolicyHex: string;
  nftNameHex: string;
  payoutLovelace: string;
  vaultRef: string;
};

export type MockPoolState = {
  availableLovelace: string;
  encumberedLovelace: string;
  /** Principal colocado en préstamos (mock), alineado a datum.debt agregado. */
  deployedToLoansLovelace: string;
  totalDepositedLovelace: string;
  totalPaidOutLovelace: string;
  totalRepaidPrincipalLovelace: string;
  profitsFromLoansLovelace: string;
  profitsFromInsuranceLovelace: string;
  reservations: PoolReservation[];
  /** key policy|name → outstanding principal (string lovelace) */
  outstandingLoans: Record<string, string>;
};

function ensureDir(): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function defaultPool(): MockPoolState {
  return {
    availableLovelace: "0",
    encumberedLovelace: "0",
    deployedToLoansLovelace: "0",
    totalDepositedLovelace: "0",
    totalPaidOutLovelace: "0",
    totalRepaidPrincipalLovelace: "0",
    profitsFromLoansLovelace: "0",
    profitsFromInsuranceLovelace: "0",
    reservations: [],
    outstandingLoans: {},
  };
}

let poolMem: MockPoolState | null = null;

export function nftLoanKey(nftPolicyHex: string, nftNameHex: string): string {
  return `${nftPolicyHex.toLowerCase()}|${nftNameHex.toLowerCase()}`;
}

function migratePool(raw: unknown): MockPoolState {
  const o =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const b = defaultPool();
  const reservations = Array.isArray(o.reservations)
    ? (o.reservations as PoolReservation[])
    : [];
  const outstandingLoans =
    typeof o.outstandingLoans === "object" &&
    o.outstandingLoans !== null &&
    !Array.isArray(o.outstandingLoans)
      ? (o.outstandingLoans as Record<string, string>)
      : {};
  return {
    availableLovelace: String(o.availableLovelace ?? b.availableLovelace),
    encumberedLovelace: String(o.encumberedLovelace ?? b.encumberedLovelace),
    deployedToLoansLovelace: String(
      o.deployedToLoansLovelace ?? b.deployedToLoansLovelace,
    ),
    totalDepositedLovelace: String(
      o.totalDepositedLovelace ?? b.totalDepositedLovelace,
    ),
    totalPaidOutLovelace: String(
      o.totalPaidOutLovelace ?? b.totalPaidOutLovelace,
    ),
    totalRepaidPrincipalLovelace: String(
      o.totalRepaidPrincipalLovelace ?? b.totalRepaidPrincipalLovelace,
    ),
    profitsFromLoansLovelace: String(
      o.profitsFromLoansLovelace ?? b.profitsFromLoansLovelace,
    ),
    profitsFromInsuranceLovelace: String(
      o.profitsFromInsuranceLovelace ?? b.profitsFromInsuranceLovelace,
    ),
    reservations,
    outstandingLoans,
  };
}

export function loadPool(): MockPoolState {
  if (poolMem) return poolMem;
  ensureDir();
  if (!fs.existsSync(POOL_PATH)) {
    poolMem = defaultPool();
    return poolMem;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(POOL_PATH, "utf8")) as unknown;
    poolMem = migratePool(raw);
    return poolMem;
  } catch {
    poolMem = defaultPool();
    return poolMem;
  }
}

export function savePool(p: MockPoolState): void {
  poolMem = p;
  ensureDir();
  fs.writeFileSync(POOL_PATH, JSON.stringify(p, null, 2), "utf8");
}

export function poolDeposit(lovelace: bigint): MockPoolState {
  const p = loadPool();
  const av = BigInt(p.availableLovelace) + lovelace;
  const td = BigInt(p.totalDepositedLovelace) + lovelace;
  p.availableLovelace = av.toString();
  p.totalDepositedLovelace = td.toString();
  savePool(p);
  return p;
}

/** Tras retiro on-chain del script pool: baja liquidez disponible del mock (sin ir a negativo). */
export function poolWithdraw(lovelace: bigint): MockPoolState {
  if (lovelace <= 0n) return loadPool();
  const p = loadPool();
  const av = BigInt(p.availableLovelace);
  const sub = lovelace > av ? av : lovelace;
  p.availableLovelace = (av - sub).toString();
  savePool(p);
  return p;
}

/** Llamar solo tras openVault on-chain OK: saca liquidez del pool para el principal del préstamo. */
export function poolCommitLoan(params: {
  nftPolicyHex: string;
  nftNameHex: string;
  loanLovelace: bigint;
}): void {
  if (params.loanLovelace <= 0n) return;
  const p = loadPool();
  const av = BigInt(p.availableLovelace);
  if (av < params.loanLovelace) {
    throw new Error(
      "poolCommitLoan: liquidez insuficiente (revisá pre-checks del servidor)",
    );
  }
  const key = nftLoanKey(params.nftPolicyHex, params.nftNameHex);
  if (p.outstandingLoans[key] != null) {
    throw new Error("poolCommitLoan: ya hay préstamo activo para este NFT");
  }
  p.availableLovelace = (av - params.loanLovelace).toString();
  p.deployedToLoansLovelace = (
    BigInt(p.deployedToLoansLovelace) + params.loanLovelace
  ).toString();
  p.outstandingLoans[key] = params.loanLovelace.toString();
  savePool(p);
}

/**
 * Tras adjustDebt: más deuda consume pool; menos devuelve principal + interés demo al pool.
 */
export function poolOnDebtAdjusted(params: {
  nftPolicyHex: string;
  nftNameHex: string;
  oldDebtLovelace: bigint;
  newDebtLovelace: bigint;
}): void {
  const oldD = params.oldDebtLovelace;
  const newD = params.newDebtLovelace;
  if (oldD === newD) return;

  const p = loadPool();
  const key = nftLoanKey(params.nftPolicyHex, params.nftNameHex);
  const deployed = BigInt(p.deployedToLoansLovelace);

  if (newD > oldD) {
    const more = newD - oldD;
    const av = BigInt(p.availableLovelace);
    if (av < more) {
      throw new Error("poolOnDebtAdjusted: liquidez insuficiente");
    }
    p.availableLovelace = (av - more).toString();
    p.deployedToLoansLovelace = (deployed + more).toString();
    p.outstandingLoans[key] = newD.toString();
    savePool(p);
    return;
  }

  const repaid = oldD - newD;
  const interest = (repaid * LOAN_REPAY_INTEREST_BPS) / 10000n;
  p.availableLovelace = (
    BigInt(p.availableLovelace) + repaid + interest
  ).toString();
  p.deployedToLoansLovelace = (deployed - repaid).toString();
  p.totalRepaidPrincipalLovelace = (
    BigInt(p.totalRepaidPrincipalLovelace) + repaid
  ).toString();
  p.profitsFromLoansLovelace = (
    BigInt(p.profitsFromLoansLovelace) + interest
  ).toString();
  if (newD === 0n) delete p.outstandingLoans[key];
  else p.outstandingLoans[key] = newD.toString();
  savePool(p);
}

/** Tras liquidación: colateral “vendido” — recupera principal + excedente demo al pool. */
export function poolOnLiquidateLoan(params: {
  nftPolicyHex: string;
  nftNameHex: string;
  debtLovelace: bigint;
}): void {
  const D = params.debtLovelace;
  if (D <= 0n) return;
  const p = loadPool();
  const key = nftLoanKey(params.nftPolicyHex, params.nftNameHex);
  const surplus = (D * LIQUIDATION_POOL_SURPLUS_BPS) / 10000n;
  const recovery = D + surplus;
  p.availableLovelace = (BigInt(p.availableLovelace) + recovery).toString();
  p.deployedToLoansLovelace = (
    BigInt(p.deployedToLoansLovelace) - D
  ).toString();
  p.profitsFromLoansLovelace = (
    BigInt(p.profitsFromLoansLovelace) + surplus
  ).toString();
  delete p.outstandingLoans[key];
  savePool(p);
}

export function poolFinalizeCloseVault(params: {
  nftPolicyHex: string;
  nftNameHex: string;
}): void {
  const p = loadPool();
  const key = nftLoanKey(params.nftPolicyHex, params.nftNameHex);
  delete p.outstandingLoans[key];
  savePool(p);
}

/**
 * Liquidez efectiva para una nueva reserva de seguro: disponible + reemplazo de reserva del mismo NFT.
 */
export function poolEffectiveAvailableForInsuranceReserve(
  nftPolicyHex: string,
  nftNameHex: string,
): bigint {
  const p = loadPool();
  let av = BigInt(p.availableLovelace);
  const pol = nftPolicyHex.toLowerCase();
  const nm = nftNameHex.toLowerCase();
  const prev = p.reservations.find(
    (r) => r.nftPolicyHex === pol && r.nftNameHex === nm,
  );
  if (prev) av += BigInt(prev.payoutLovelace);
  return av;
}

/**
 * Al contratar cobertura: aparta hasta `payoutRequested` del disponible (mock).
 */
export function poolReserveForHedge(params: {
  nftPolicyHex: string;
  nftNameHex: string;
  vaultRef: string;
  payoutRequested: bigint;
}): { reserved: bigint; shortfall: bigint } {
  const p = loadPool();
  const pol = params.nftPolicyHex.toLowerCase();
  const nm = params.nftNameHex.toLowerCase();
  const prevIdx = p.reservations.findIndex(
    (r) => r.nftPolicyHex === pol && r.nftNameHex === nm,
  );
  if (prevIdx >= 0) {
    const old = p.reservations[prevIdx]!;
    const oldAmt = BigInt(old.payoutLovelace);
    p.reservations.splice(prevIdx, 1);
    p.encumberedLovelace = (BigInt(p.encumberedLovelace) - oldAmt).toString();
    p.availableLovelace = (BigInt(p.availableLovelace) + oldAmt).toString();
  }
  const av = BigInt(p.availableLovelace);
  const req = params.payoutRequested;
  const reserved = req <= av ? req : av;
  const shortfall = req - reserved;
  p.availableLovelace = (av - reserved).toString();
  p.encumberedLovelace = (BigInt(p.encumberedLovelace) + reserved).toString();
  p.reservations.push({
    nftPolicyHex: params.nftPolicyHex.toLowerCase(),
    nftNameHex: params.nftNameHex.toLowerCase(),
    payoutLovelace: reserved.toString(),
    vaultRef: params.vaultRef,
  });
  savePool(p);
  return { reserved, shortfall };
}

/** Liquidación o cierre: la reserva vuelve al disponible (no es pago al asegurado). */
export function poolCancelReservation(params: {
  nftPolicyHex: string;
  nftNameHex: string;
}): { returned: bigint; found: boolean } {
  const p = loadPool();
  const pol = params.nftPolicyHex.toLowerCase();
  const nm = params.nftNameHex.toLowerCase();
  const idx = p.reservations.findIndex(
    (r) => r.nftPolicyHex === pol && r.nftNameHex === nm,
  );
  if (idx < 0) return { returned: 0n, found: false };
  const r = p.reservations[idx]!;
  const amt = BigInt(r.payoutLovelace);
  p.reservations.splice(idx, 1);
  p.encumberedLovelace = (BigInt(p.encumberedLovelace) - amt).toString();
  p.availableLovelace = (BigInt(p.availableLovelace) + amt).toString();
  savePool(p);
  return { returned: amt, found: true };
}

export function poolReleaseOnClaim(params: {
  nftPolicyHex: string;
  nftNameHex: string;
}): { released: bigint; poolFee: bigint; paidOut: bigint; found: boolean } {
  const p = loadPool();
  const pol = params.nftPolicyHex.toLowerCase();
  const nm = params.nftNameHex.toLowerCase();
  const idx = p.reservations.findIndex(
    (r) => r.nftPolicyHex === pol && r.nftNameHex === nm,
  );
  if (idx < 0)
    return { released: 0n, poolFee: 0n, paidOut: 0n, found: false };
  const r = p.reservations[idx]!;
  const amt = BigInt(r.payoutLovelace);
  const poolFee = (amt * INSURANCE_POOL_FEE_BPS) / 10000n;
  const paidOut = amt - poolFee;
  p.reservations.splice(idx, 1);
  p.encumberedLovelace = (BigInt(p.encumberedLovelace) - amt).toString();
  p.availableLovelace = (BigInt(p.availableLovelace) + poolFee).toString();
  p.totalPaidOutLovelace = (
    BigInt(p.totalPaidOutLovelace) + paidOut
  ).toString();
  p.profitsFromInsuranceLovelace = (
    BigInt(p.profitsFromInsuranceLovelace) + poolFee
  ).toString();
  savePool(p);
  return { released: amt, poolFee, paidOut, found: true };
}

export function readAudit(limit: number): AuditEvent[] {
  ensureDir();
  if (!fs.existsSync(AUDIT_PATH)) return [];
  try {
    const arr = JSON.parse(
      fs.readFileSync(AUDIT_PATH, "utf8"),
    ) as AuditEvent[];
    return arr.slice(0, Math.min(limit, MAX_AUDIT));
  } catch {
    return [];
  }
}

export function appendAudit(
  e: Omit<AuditEvent, "ts"> & { ts?: string },
): void {
  ensureDir();
  const prev = (() => {
    if (!fs.existsSync(AUDIT_PATH)) return [] as AuditEvent[];
    try {
      return JSON.parse(fs.readFileSync(AUDIT_PATH, "utf8")) as AuditEvent[];
    } catch {
      return [];
    }
  })();
  const row: AuditEvent = {
    ts: e.ts ?? new Date().toISOString(),
    kind: e.kind,
    summary: e.summary,
    txHash: e.txHash,
    extra: e.extra,
  };
  prev.unshift(row);
  fs.writeFileSync(
    AUDIT_PATH,
    JSON.stringify(prev.slice(0, MAX_AUDIT), null, 2),
    "utf8",
  );
}
