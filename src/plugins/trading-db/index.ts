/**
 * Barrel export for trading-db plugin.
 * Re-exports database helpers, state management, and trading-specific types.
 */

export {
  logConversation,
  getRecentConversations,
  saveMemory,
  getMemories,
  getStrategy,
  activateStrategy,
  logCronRun,
  getLastCronSuccess,
  closePool,
} from "./db";

export {
  readState,
  writeState,
  stateAge,
  getStateDir,
  setStateDir,
} from "./state";

export type {
  MarketRegimeState,
  ActiveStrategy,
  ActiveStrategiesState,
  TradeRecord,
  PerformanceLogState,
  ResearchRequest,
  ResearchQueueState,
  DbStrategy,
  DbPosition,
  DbRegimeLog,
  DbConversation,
  DbCronLog,
  DbMemory,
  ClaudeRunResult,
  ClaudeRunMode,
} from "./types";
