/**
 * Trading command handlers extracted from the strategist relay.
 *
 * Each handler is a standalone function that returns a string response
 * (or builds an enriched prompt for Claude invocation). The actual Claude
 * spawning is handled by tinyclaw's invoke system — these functions only
 * prepare the data.
 *
 * Security conventions preserved from strategist:
 * - Parameterized SQL via trading-db plugin (never inline SQL)
 * - Input validation before any processing
 * - Rate limiting for Claude-spawning commands
 * - Fail-closed patterns
 */

import { readState, getStateDir } from "../trading-db/state";
import {
  getStrategy,
  activateStrategy,
  logConversation,
  getLatestRegime,
} from "../trading-db/db";
import { buildPrompt, buildResearchPrompt } from "../trading-prompts/prompt-builder";
import type {
  ActiveStrategiesState,
  PerformanceLogState,
} from "../trading-db/types";

// ============================================================
// INPUT VALIDATION
// ============================================================

const STRATEGY_ID_RE = /^[a-zA-Z0-9_-]{1,50}$/;

/**
 * Validate a strategy ID string.
 * Returns an error message if invalid, or null if valid.
 */
export function validateStrategyId(id: string): string | null {
  if (!STRATEGY_ID_RE.test(id)) {
    return "Invalid strategy_id. Use only letters, numbers, hyphens, underscores (max 50 chars).";
  }
  return null;
}

/**
 * Validate a text input string for length.
 * Returns an error message if invalid, or null if valid.
 */
export function validateTextInput(
  text: string,
  maxLen: number,
  fieldName: string
): string | null {
  if (text.length > maxLen) {
    return `${fieldName} too long (max ${maxLen} chars, got ${text.length}).`;
  }
  return null;
}

// ============================================================
// RATE LIMITING: Sliding window for Claude spawns
// ============================================================

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 5;
const claudeSpawnTimestamps: number[] = [];

/**
 * Check if a Claude spawn is allowed under the rate limit.
 * Returns true if allowed (and records the timestamp), false if rate limited.
 */
export function checkRateLimit(): boolean {
  const now = Date.now();
  // Remove expired entries
  while (
    claudeSpawnTimestamps.length > 0 &&
    claudeSpawnTimestamps[0] <= now - RATE_LIMIT_WINDOW_MS
  ) {
    claudeSpawnTimestamps.shift();
  }
  if (claudeSpawnTimestamps.length >= RATE_LIMIT_MAX) {
    return false;
  }
  claudeSpawnTimestamps.push(now);
  return true;
}

// ============================================================
// INSTANT COMMANDS (no Claude spawn)
// ============================================================

/**
 * /status — Quick state summary. Reads state files directly, no Claude spawn.
 */
export async function handleStatusCommand(): Promise<string> {
  const regime = await getLatestRegime();
  const strategies =
    await readState<ActiveStrategiesState>("active-strategies.json");
  const perf = await readState<PerformanceLogState>("performance-log.json");

  const sections: string[] = ["**Master Strategist Status**\n"];

  if (regime) {
    const age = Math.round(
      (Date.now() - new Date(regime.assessed_at).getTime()) / 60000
    );
    let regimeText =
      `**Market Regime:** ${regime.regime}` +
        `\nBTC: \`$${regime.btc_price?.toLocaleString()}\` (${(regime.btc_24h_change ?? 0) >= 0 ? "+" : ""}${regime.btc_24h_change?.toFixed(2)}%)` +
        `\nETH: \`$${regime.eth_price?.toLocaleString()}\` (${(regime.eth_24h_change ?? 0) >= 0 ? "+" : ""}${regime.eth_24h_change?.toFixed(2)}%)`;
    if (regime.ticker_data) {
      for (const [ticker, data] of Object.entries(regime.ticker_data)) {
        regimeText += `\n${ticker.replace("-USD", "")}: \`$${data.price?.toLocaleString()}\` (${data.change_24h >= 0 ? "+" : ""}${data.change_24h?.toFixed(2)}%)`;
      }
    }
    regimeText += `\nUpdated: ${age}m ago\n`;
    sections.push(regimeText);
  } else {
    sections.push("**Market Regime:** Not yet assessed\n");
  }

  if (strategies && strategies.strategies.length > 0) {
    const active = strategies.strategies.filter(
      (s) => s.status === "paper" || s.status === "live"
    );
    sections.push(`**Active Strategies:** ${active.length}`);
    for (const s of active) {
      sections.push(
        `  ${s.strategy_id}: ${s.asset} ${s.direction} [${s.status}]`
      );
    }
    sections.push("");
  } else {
    sections.push("**Strategies:** None active\n");
  }

  if (perf && perf.total_trades > 0) {
    sections.push(
      `**Performance:**` +
        `\n  Trades: ${perf.total_trades} | Open: ${perf.open_positions}` +
        `\n  Win rate: ${perf.win_rate !== null ? (perf.win_rate * 100).toFixed(1) + "%" : "N/A"}` +
        `\n  P&L: ${perf.total_pnl_pct !== null ? (perf.total_pnl_pct >= 0 ? "+" : "") + perf.total_pnl_pct.toFixed(2) + "%" : "N/A"}`
    );
  } else {
    sections.push("**Performance:** No trades yet");
  }

  return sections.join("\n");
}

/**
 * /help — Show available commands. Returns hardcoded help text.
 */
export async function handleHelpCommand(): Promise<string> {
  return (
    `**Claude Master Strategist**\n\n` +
    `**Commands:**\n` +
    `/status — Quick status (instant, no Claude)\n` +
    `/regime — Fresh regime analysis\n` +
    `/performance — Trade review\n` +
    `/strategies — List all strategies\n` +
    `/activate — Activate strategy for paper trading\n` +
    `/research — Research & backtest on CT110\n` +
    `/ask — Ask Claude anything\n` +
    `/reset — Reset conversation (fresh start)\n` +
    `/help — This message\n\n` +
    `**Active tickers:** ETH, SOL, XRP, BNB, DOGE\n` +
    `**Model:** ArkSignal-Strategy-v1 | **Strategy:** D_fixed_exit (long_only)\n\n` +
    `Or just send a message in the channel to chat about trading.`
  );
}

// ============================================================
// CLAUDE-SPAWNING COMMANDS (return enriched prompts)
// ============================================================

/**
 * /regime — Build the enriched prompt for a fresh regime analysis.
 * The caller is responsible for spawning Claude with the returned prompt.
 */
export async function buildRegimePrompt(): Promise<string> {
  await logConversation({
    role: "user",
    content: "/regime",
    command: "/regime",
  });

  return buildPrompt(
    "Fetch current prices for ALL tickers from the OHLCV service (localhost:8812): BTC-USD, ETH-USD, SOL-USD, XRP-USD, BNB-USD, DOGE-USD. " +
      "Calculate 24h change percentages. Determine regime (RALLY if BTC >+3%, SELLOFF if <-3%, NEUTRAL otherwise). " +
      "Assess trading bias for all active tickers (ETH, SOL, XRP, BNB, DOGE) based on BTC regime. " +
      "INSERT into strategist.regime_log with exact columns: " +
      "(assessed_at, btc_price, btc_24h_change, eth_price, eth_24h_change, regime, trading_bias, confidence, reasoning, ticker_data). " +
      "Use NOW() for assessed_at. Confidence as 0.0-1.0 decimal, not percentage. " +
      'Store SOL/XRP/BNB/DOGE prices in ticker_data as JSONB: \'{"SOL-USD": {"price": N, "change_24h": N}, ...}\'::jsonb. ' +
      "Do NOT alter or recreate the table. " +
      "Then give a 2-3 sentence trading assessment covering all active tickers."
  );
}

/**
 * /performance — Build the enriched prompt for a trade performance review.
 */
export async function buildPerformancePrompt(): Promise<string> {
  await logConversation({
    role: "user",
    content: "/performance",
    command: "/performance",
  });

  const stateDir = getStateDir();
  return buildPrompt(
    "Query ALL position tables for recent trades: " +
      "paper_trading.arksignal_v1_30m_positions (paper, 30m), " +
      "paper_trading.arksignal_v1_1h_positions (paper, 1h), " +
      "live_trading.positions (live trades). " +
      "Calculate win rate, total P&L, and identify best/worst trades. Break down by ticker and timeframe. " +
      `Write summary to ${stateDir}/performance-log.json. ` +
      "Give a concise performance report with key insights."
  );
}

/**
 * /strategies — Build the enriched prompt for listing all strategies.
 */
export async function buildStrategiesPrompt(): Promise<string> {
  await logConversation({
    role: "user",
    content: "/strategies",
    command: "/strategies",
  });

  return buildPrompt(
    "Query strategist.strategies table and list all strategies with their status, asset, direction, and last backtest results. " +
      "Format as a clean list. If no strategies exist, say so."
  );
}

/**
 * /activate <strategy_id> — Validate and activate a strategy, then build
 * the enriched prompt for Claude to confirm and refresh state.
 *
 * Returns the prompt string on success, or an object with an error message
 * if validation fails (so the caller can reply without spawning Claude).
 */
export async function buildActivatePrompt(
  strategyId: string
): Promise<{ prompt: string; error?: string }> {
  // Input validation
  const idError = validateStrategyId(strategyId);
  if (idError) {
    return { prompt: "", error: idError };
  }

  await logConversation({
    role: "user",
    content: `/activate ${strategyId}`,
    command: "/activate",
  });

  // Pre-activation validation
  const strategy = await getStrategy(strategyId);

  if (!strategy) {
    return {
      prompt: "",
      error: `Strategy \`${strategyId}\` not found. Use /strategies to see available strategies.`,
    };
  }

  if (strategy.status === "paper" || strategy.status === "live") {
    return {
      prompt: "",
      error: `Strategy \`${strategyId}\` is already active (status: ${strategy.status}).`,
    };
  }

  if (!strategy.backtest_results) {
    return {
      prompt: "",
      error: `Strategy \`${strategyId}\` has no backtest results. Run \`/research\` first to validate it.`,
    };
  }

  // Check backtest quality
  let qualityWarning = "";
  try {
    const bt = JSON.parse(strategy.backtest_results);
    const winRate = bt.win_rate ?? bt.winRate ?? null;
    const sharpe = bt.sharpe ?? bt.sharpe_ratio ?? null;
    const warnings: string[] = [];
    if (winRate !== null && winRate < 0.52) {
      warnings.push(`win rate ${(winRate * 100).toFixed(1)}% (< 52%)`);
    }
    if (sharpe !== null && sharpe < 0.5) {
      warnings.push(`Sharpe ${sharpe.toFixed(2)} (< 0.5)`);
    }
    if (warnings.length > 0) {
      qualityWarning =
        ` Note: activating despite poor backtest metrics — ${warnings.join(", ")}.`;
    }
  } catch {
    // backtest_results wasn't valid JSON — proceed anyway
  }

  // Activate directly via parameterized query — never pass SQL to Claude
  await activateStrategy(strategyId);

  const stateDir = getStateDir();
  const prompt = await buildPrompt(
    `Strategy '${strategyId}' has been activated for paper trading.${qualityWarning} ` +
      `Refresh ${stateDir}/active-strategies.json with all active strategies from the DB. ` +
      `Confirm activation with the strategy details.`
  );

  return { prompt };
}

/**
 * /ask <question> — Build the enriched prompt for a free-form question.
 */
export async function buildAskPrompt(question: string): Promise<string> {
  const qError = validateTextInput(question, 2000, "Question");
  if (qError) {
    throw new Error(qError);
  }

  await logConversation({
    role: "user",
    content: `/ask ${question}`,
    command: "/ask",
  });

  return buildPrompt(question);
}

/**
 * /research <description> — Build the research prompt for CT110.
 * Returns the prompt string. The caller handles SSH + Claude spawn.
 */
export async function buildResearchCommandPrompt(
  description: string
): Promise<string> {
  const descError = validateTextInput(description, 500, "Description");
  if (descError) {
    throw new Error(descError);
  }

  await logConversation({
    role: "user",
    content: `/research ${description}`,
    command: "/research",
  });

  return buildResearchPrompt(description);
}
