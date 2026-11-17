// Launch Signal's model (radar-2): one snapshot of the protocol universe in, one ranked board out.
//
// The board covers every slug in the snapshot's watchlist (the floor, never a ceiling) and adds the
// strongest pre-token protocols below the floor: the early rows a radar exists to find. A protocol is
// pre-token when its record carries no token (no market cap, no CoinGecko id, no symbol). Protocols
// whose token already trades are kept apart in a live set and shown at the market's own values.
//
// The implied value is derived from the snapshot's own figures, in four factors:
//
//   peer      the market's own yardstick: the median market-cap / TVL ratio of the snapshot's
//             live-token protocols in the same category (the global median when a category has
//             fewer than PEER_MIN_SAMPLE live peers). No multiple is hardcoded: if the snapshot's
//             market re-rates a category, every pre-token row in it moves with it.
//   growth    1 + clamp(change_7d, -60, 120) / 100 x GROWTH_WEIGHT: a week of TVL momentum.
//   maturity  0.6 rising to 1.0 over three years tracked with no token: the longer a protocol has
//             run tokenless at size, the more of its value a launch would have to recognise.
//   breadth   1 + 0.05 per doubling of the chain count, capped at 1.15: distribution a token
//             would inherit on day one.
//
//   implied   = max(1, round(tvl_usd x peer x growth x maturity x breadth))
//
// Each row also carries a data-confidence grade and plain-language risk flags, both read off the
// same record. No protocol name is ever special-cased: one function scores every row, and the
// dashboard restates the arithmetic so a reader can check any row by hand.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's tunable constants; the peer multiples themselves are measured, not tuned. */
export interface ModelConstants {
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
  breadth_per_doubling: number;
  breadth_cap: number;
  peer_min_sample: number;
  peer_multiple_floor: number;
  peer_multiple_cap: number;
}

export const MODEL: ModelConstants = {
  growth_weight: 0.5,
  growth_floor: -60,
  growth_cap: 120,
  maturity_floor: 0.6,
  maturity_range: 0.4,
  maturity_days: 1095,
  unknown_age_days: 365,
  breadth_per_doubling: 0.05,
  breadth_cap: 1.15,
  peer_min_sample: 4,
  peer_multiple_floor: 0.02,
  peer_multiple_cap: 3,
};

/** The model's version label: the dashboard names it and the board's rows carry it. */
export const MODEL_VERSION = 'radar-2';

/** How many pre-token protocols below the watchlist floor the early radar carries, by TVL. */
export const EARLY_ROWS = 280;

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_ROWS = 36;

/** The peer yardstick: median market-cap / TVL per category, measured from the snapshot. */
export interface PeerTable {
  global_multiple: number;
  global_sample: number;
  by_category: Map<string, { multiple: number; sample: number }>;
}

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  on_watchlist: boolean;
  age_days: number | null;
  implied_value_usd: number;
  confidence: 'high' | 'medium' | 'low';
  risk_flags: string[];
  model: {
    peer_multiple: number;
    peer_sample: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    breadth_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** The dashboard's view of one row: everything the page renders, farm plan included. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  on_watchlist: boolean;
  implied_value_usd: number;
  confidence: 'high' | 'medium' | 'low';
  risk_flags: string[];
  peer_multiple: number;
  peer_sample: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  breadth_multiplier: number;
  farm_steps: string[];
}

/** A live-token protocol: it already trades, so the board shows the market's own value, not a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
  value_per_tvl: number | null;
}

/** Everything the dashboard needs: the board, the live set, the peer table and the model it runs. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  peer_global: number;
  peer_global_sample: number;
  peer_categories: { category: string; multiple: number; sample: number }[];
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  total_implied_usd: number;
  rows: RadarRow[];
  live: LiveRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** The median of a non-empty list of numbers. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * The peer yardstick, measured from the snapshot itself: for every live-token protocol with a
 * market cap and a TVL, the ratio of the two; the median of those ratios overall and per category.
 */
export function peerTable(snapshot: Snapshot, model: ModelConstants = MODEL): PeerTable {
  const clamp = (n: number): number => Math.min(model.peer_multiple_cap, Math.max(model.peer_multiple_floor, n));
  const all: number[] = [];
  const perCategory = new Map<string, number[]>();
  for (const p of snapshot.protocols) {
    if (p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) continue;
    const ratio = p.mcap_usd / p.tvl_usd;
    all.push(ratio);
    if (p.category !== null) {
      const list = perCategory.get(p.category) ?? [];
      list.push(ratio);
      perCategory.set(p.category, list);
    }
  }
  const byCategory = new Map<string, { multiple: number; sample: number }>();
  for (const [category, ratios] of perCategory) {
    byCategory.set(category, { multiple: clamp(median(ratios)), sample: ratios.length });
  }
  return {
    global_multiple: all.length > 0 ? clamp(median(all)) : 0.2,
    global_sample: all.length,
    by_category: byCategory,
  };
}

/** The peer multiple one protocol is measured against, and how many live peers set it. */
function peerFor(p: SnapshotProtocol, peers: PeerTable, model: ModelConstants): { multiple: number; sample: number } {
  if (p.category !== null) {
    const entry = peers.by_category.get(p.category);
    if (entry !== undefined && entry.sample >= model.peer_min_sample) return entry;
  }
  return { multiple: peers.global_multiple, sample: peers.global_sample };
}

/** The model's factors and the implied value one protocol gets. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  peers: PeerTable,
  model: ModelConstants = MODEL,
): { implied: number; peerMultiple: number; peerSample: number; growthPct: number; growthMult: number; maturityMult: number; breadthMult: number; age: number | null } {
  const age = ageDays(asOf, protocol.listed_at);
  const peer = peerFor(protocol, peers, model);
  const rawGrowth = finite(protocol.change_7d, 0);
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, rawGrowth));
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const ageForModel = age ?? model.unknown_age_days;
  const maturityMult = model.maturity_floor + (Math.min(Math.max(ageForModel, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
  const breadthMult = Math.min(model.breadth_cap, 1 + model.breadth_per_doubling * Math.log2(Math.max(1, protocol.chains.length)));
  const implied = Math.max(1, Math.round(protocol.tvl_usd * peer.multiple * growthMult * maturityMult * breadthMult));
  return { implied, peerMultiple: peer.multiple, peerSample: peer.sample, growthPct, growthMult, maturityMult, breadthMult, age };
}

/** How much of a protocol's record the model can actually see: the confidence grade. */
export function confidenceOf(p: SnapshotProtocol): 'high' | 'medium' | 'low' {
  let points = 0;
  if (p.change_7d !== null) points += 1;
  if (p.listed_at !== null) points += 1;
  if (p.category !== null) points += 1;
  if (p.chains.length >= 2) points += 1;
  if (points >= 3) return 'high';
  if (points === 2) return 'medium';
  return 'low';
}

/** Plain-language warnings read off the record: decline, youth, thin footprint, missing data. */
export function riskFlags(p: SnapshotProtocol, age: number | null): string[] {
  const flags: string[] = [];
  if (p.change_7d !== null && p.change_7d <= -15) {
    flags.push(`TVL fell ${Math.abs(p.change_7d).toFixed(1)}% in the last 7 days: momentum is against it`);
  } else if (p.change_7d !== null && p.change_7d <= -5) {
    flags.push(`TVL is drifting down (${p.change_7d.toFixed(1)}% in 7 days)`);
  }
  if (age !== null && age < 90) flags.push(`Tracked for only ${age} days: a short record to judge by`);
  if (p.chains.length <= 1) flags.push('Single-chain footprint: no distribution beyond one network');
  if (p.category === null) flags.push('No category recorded, so it is priced on the global peer median');
  if (p.listed_at === null) flags.push('No listing date recorded: its age, and so its maturity factor, is assumed');
  if (p.change_7d === null) flags.push('No 7-day TVL change reported: its growth factor is neutral');
  return flags.slice(0, 4);
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Categories that are products of another protocol's assets, not launches of their own. */
const PRODUCT_CATEGORIES = new Set(['CEX', 'Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC']);

/** A whole word wrapped, staked or staking in a name marks a product of a token that already trades. */
const PRODUCT_WORD = /\b(wrapped|staked|staking)\b/i;

/** Names that begin with an exchange's name are that exchange's product, not a new protocol. */
const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/**
 * Whether a protocol below the floor is a genuine early-radar subject: pre-token, and not an
 * exchange, a versioned pool, or a wrapped, staked or bridged product of a token that trades.
 * The watchlist itself is never filtered by this: the gate's coverage is not gambled on a rule.
 */
export function isEarlyRankable(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  if (p.category !== null && PRODUCT_CATEGORIES.has(p.category)) return false;
  if (VERSIONED.test(p.name) || PRODUCT_WORD.test(p.name) || EXCHANGE_PREFIX.test(p.name)) return false;
  return true;
}

/** The snapshot's protocol by slug. */
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

/** The headline sentence's figures: how many watchlist slugs, how many rows, how many live protocols. */
export interface BoardSummary {
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const peers = peerTable(snapshot, model);
  const index = bySlug(snapshot.protocols);
  const watch = new Set(snapshot.watchlist);
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug on it is ranked, whatever the early-radar rules say.
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar: genuine pre-token protocols below the floor, by TVL, capped.
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isEarlyRankable(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, EARLY_ROWS);
  for (const p of early) chosen.set(p.slug, p);

  const scored = [...chosen.values()].map((p) => {
    const v = impliedValue(p, snapshot.as_of, peers, model);
    return { p, v };
  });
  scored.sort((a, b) => b.v.implied - a.v.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    on_watchlist: watch.has(s.p.slug),
    age_days: s.v.age,
    implied_value_usd: s.v.implied,
    confidence: confidenceOf(s.p),
    risk_flags: riskFlags(s.p, s.v.age),
    model: {
      peer_multiple: round4(s.v.peerMultiple),
      peer_sample: s.v.peerSample,
      growth_pct: s.v.growthPct,
      growth_multiplier: round4(s.v.growthMult),
      maturity_multiplier: round4(s.v.maturityMult),
      breadth_multiplier: round4(s.v.breadthMult),
      age_days: s.v.age,
    },
    farm_steps: farmSteps(s.p, s.v.age).map(stepText),
  }));
}

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The category's one action, in the words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC to ${name} on ${chain}, then borrow a small amount against it so both sides of the market see the wallet`;
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm')) return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and make one swap through the same interface`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds in one app on the far side`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt token in the same wallet`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Deposit $${capital} of USDC as margin on ${name} and open one small hedged trade, then close it a day later`;
  if (c.includes('prediction')) return `Fund $${capital} and take one position in a liquid market on ${name}, letting it settle`;
  if (c.includes('curator') || c.includes('allocator')) return `Deposit $${capital} into a ${name} vault on ${chain} and leave the shares untouched while they accrue`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain} and hold it in the wallet`;
  if (c.includes('rwa')) return `Mint $${capital} of the protocol's yield asset on ${chain} through ${name} and hold it to term`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy active for a full month`;
  if (c.includes('basis')) return `Open a $${capital} basis position through ${name} on ${chain} and let the funding accrue`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open and untouched`;
}

/**
 * A protocol's farm plan: seven steps, each an action with a cost and a time. The plan is derived
 * from the protocol's own record (category, chains, TVL, age), never from a hand-written list of
 * names, and it ends with the discipline that keeps a farm honest: a cap, a log and a clean exit.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const action = actionFor(p, capital, chain);
  const secondChain = p.chains.length > 1 ? p.chains[1]! : null;
  return [
    {
      text: `Set up a fresh wallet for ${p.name} alone, fund it from your main wallet, and keep its seed phrase offline and never typed into a site`,
      cost: 'under $3 of gas for the funding transaction',
      time: '10 minutes',
    },
    {
      text: action,
      cost: `$${capital} of capital and about $${capital >= 150 ? 8 : 4} of gas`,
      time: '15 minutes to set up',
    },
    {
      text:
        secondChain !== null
          ? `Repeat a smaller version of the same position on ${secondChain}, the protocol's second network, so the wallet is visible on more than one chain`
          : `Return once a week and make one qualifying action, such as a deposit, a borrow, a swap or a vote, so the wallet reads as a user and not a snapshot`,
      cost: secondChain !== null ? `about $${Math.round(capital / 2)} of capital and $3 of gas` : 'about $2 of gas a week',
      time: secondChain !== null ? '10 minutes' : '10 minutes a week',
    },
    {
      text: `Open ${p.name}'s own points, rewards or season page if it runs one and check the wallet is earning; if it shows nothing, the position itself is the record`,
      cost: 'nothing to check, and never pay anyone to check for you',
      time: '5 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days so the activity spans more than one weekly snapshot of the protocol's users`,
      cost: `the $${capital} stays in the position, earning or idle`,
      time: `${hold} days`,
    },
    {
      text: `Cap the farm at this one position: ${p.name} records no token today and may never issue one, so treat the $${capital} as money spent on a chance, not an investment`,
      cost: `at most $${capital} at risk, plus gas already spent`,
      time: 'one decision, made before you start',
    },
    {
      text: `Keep a farm log with the wallet, the dates and every transaction hash, and when you exit, withdraw only through the protocol's own published link`,
      cost: 'nothing but the log, and normal gas to withdraw',
      time: '5 minutes a week, 15 minutes to exit',
    },
  ];
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
      value_per_tvl: p.mcap_usd !== null && p.tvl_usd > 0 ? round4(p.mcap_usd / p.tvl_usd) : null,
    }));
}

/** A board row's form for data.js: everything the page renders. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    on_watchlist: row.on_watchlist,
    implied_value_usd: row.implied_value_usd,
    confidence: row.confidence,
    risk_flags: row.risk_flags,
    peer_multiple: row.model.peer_multiple,
    peer_sample: row.model.peer_sample,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    breadth_multiplier: row.model.breadth_multiplier,
    farm_steps: row.farm_steps,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const peers = peerTable(snapshot, model);
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const early = board.filter((r) => !r.on_watchlist).length;
  const peerCategories = [...peers.by_category.entries()]
    .map(([category, v]) => ({ category, multiple: round4(v.multiple), sample: v.sample }))
    .sort((a, b) => b.sample - a.sample || (a.category < b.category ? -1 : 1));
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    peer_global: round4(peers.global_multiple),
    peer_global_sample: peers.global_sample,
    peer_categories: peerCategories,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    total_implied_usd: board.reduce((sum, r) => sum + r.implied_value_usd, 0),
    rows: board.map(radarRow),
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  if (board.length < 100) return `the board holds ${board.length} rows: the gate wants at least 100`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `${r.slug} has a farm step of ${t.length} characters once trimmed`;
    }
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
