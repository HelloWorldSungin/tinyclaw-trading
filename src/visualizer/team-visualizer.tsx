#!/usr/bin/env node
/**
 * Team Visualizer — Real-time TUI for watching team collaboration chains.
 *
 * Watches ~/.tinyclaw/events/ for structured JSON events emitted by the
 * queue processor and renders a live dashboard with Ink (React for CLI).
 *
 * Usage:  node dist/team-visualizer.js [--team <id>]
 */

import React, { useState, useEffect, useCallback } from 'react';
import { render, Box, Text, useApp, useInput, Newline } from 'ink';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

// ─── Paths ──────────────────────────────────────────────────────────────────
const __filename_ = fileURLToPath(import.meta.url);
const __dirname_ = path.dirname(__filename_);
const _localTinyclaw = path.join(__dirname_, '..', '..', '.tinyclaw');
const TINYCLAW_HOME = fs.existsSync(path.join(_localTinyclaw, 'settings.json'))
    ? _localTinyclaw
    : path.join(os.homedir(), '.tinyclaw');
const EVENTS_DIR = path.join(TINYCLAW_HOME, 'events');
const SETTINGS_FILE = path.join(TINYCLAW_HOME, 'settings.json');

// ─── Types ──────────────────────────────────────────────────────────────────

interface TeamConfig {
    name: string;
    agents: string[];
    leader_agent: string;
}

interface AgentConfig {
    name: string;
    provider: string;
    model: string;
    working_directory: string;
}

interface TinyClawEvent {
    type: string;
    timestamp: number;
    [key: string]: unknown;
}

type AgentStatus = 'idle' | 'active' | 'done' | 'error' | 'waiting';

interface AgentState {
    id: string;
    name: string;
    provider: string;
    model: string;
    status: AgentStatus;
    lastActivity: string;
    responseLength?: number;
    lastHeartbeat?: number; // epoch seconds from heartbeat-state/
    heartbeatInterval?: number; // seconds from settings
}

interface TradingState {
    regime: { regime: string; btcPrice: number; btc24h: number; ethPrice: number; eth24h: number; confidence: number; assessedAt: string } | null;
    strategies: { id: string; name: string; asset: string; direction: string; status: string }[];
    performance: { totalTrades: number; openPositions: number; winRate: number | null; pnl: number | null; reviewedAt: string } | null;
    dbConnected: boolean | null;
}

interface ChainArrow {
    from: string;
    to: string;
    step: number;
    timestamp: number;
}

interface LogEntry {
    time: string;
    icon: string;
    text: string;
    color: string;
}

// ─── Settings loader ────────────────────────────────────────────────────────

function loadSettings(): { teams: Record<string, TeamConfig>; agents: Record<string, AgentConfig> } {
    try {
        const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
        const settings = JSON.parse(raw);
        return {
            teams: settings.teams || {},
            agents: settings.agents || {},
        };
    } catch {
        return { teams: {}, agents: {} };
    }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function timeAgo(ts: number): string {
    const diff = Math.floor((Date.now() - ts) / 1000);
    if (diff < 5) return 'just now';
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    return `${Math.floor(diff / 3600)}h ago`;
}

function shortTime(ts: number): string {
    return new Date(ts).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function truncate(s: string, max: number): string {
    if (s.length <= max) return s;
    return s.slice(0, max - 1) + '\u2026';
}

const STATUS_ICON: Record<AgentStatus, string> = {
    idle: '\u25CB',     // ○
    active: '\u25CF',   // ●
    done: '\u2713',     // ✓
    error: '\u2717',    // ✗
    waiting: '\u25D4',  // ◔
};

const STATUS_COLOR: Record<AgentStatus, string> = {
    idle: 'gray',
    active: 'cyan',
    done: 'green',
    error: 'red',
    waiting: 'yellow',
};

// ─── Components ─────────────────────────────────────────────────────────────

function Header({ teamId, teamName, uptime }: { teamId: string | null; teamName: string | null; uptime: string }) {
    return (
        <Box flexDirection="column" marginBottom={1}>
            <Box>
                <Text bold color="magenta">{'  \u2726 '}</Text>
                <Text bold color="white">TinyClaw Team Visualizer</Text>
                <Text color="gray">{' \u2502 '}</Text>
                {teamId ? (
                    <Text>
                        <Text color="cyan" bold>@{teamId}</Text>
                        <Text color="gray"> ({teamName})</Text>
                    </Text>
                ) : (
                    <Text color="yellow">all teams</Text>
                )}
                <Text color="gray">{' \u2502 '}</Text>
                <Text color="gray">{uptime}</Text>
            </Box>
            <Text color="gray">{'\u2500'.repeat(72)}</Text>
        </Box>
    );
}

function AgentCard({ agent, isLeader }: { agent: AgentState; isLeader: boolean }) {
    const color = STATUS_COLOR[agent.status];
    const icon = STATUS_ICON[agent.status];
    return (
        <Box
            flexDirection="column"
            borderStyle="round"
            borderColor={agent.status === 'active' ? 'cyan' : agent.status === 'done' ? 'green' : 'gray'}
            paddingX={1}
            width={30}
        >
            <Box>
                <Text color={color}>{icon} </Text>
                <Text bold color="white">@{agent.id}</Text>
                {isLeader && <Text color="yellow"> {'\u2605'}</Text>}
            </Box>
            <Text color="gray">{agent.name}</Text>
            <Text dimColor>{agent.provider}/{agent.model}</Text>
            <Box marginTop={0}>
                {agent.status === 'active' ? (
                    <Text color="cyan">{'\u25B8'} Processing{dots()}</Text>
                ) : agent.status === 'done' ? (
                    <Text color="green">{'\u2713'} Done ({agent.responseLength ?? 0} chars)</Text>
                ) : agent.status === 'error' ? (
                    <Text color="red">{'\u2717'} Error</Text>
                ) : (
                    <Text color="gray">{agent.lastActivity || 'Idle'}</Text>
                )}
            </Box>
            <HeartbeatBar agent={agent} />
        </Box>
    );
}

function dots(): string {
    const n = Math.floor((Date.now() / 400) % 4);
    return '.'.repeat(n);
}

function ChainFlow({ arrows, agents }: { arrows: ChainArrow[]; agents: Record<string, AgentState> }) {
    if (arrows.length === 0) return null;
    return (
        <Box flexDirection="column" marginY={1}>
            <Text bold color="white">{'\u21C0'} Chain Flow</Text>
            <Box flexDirection="row" gap={1}>
                {arrows.map((arrow, i) => (
                    <Box key={i}>
                        <Text color="cyan" bold>@{arrow.from}</Text>
                        <Text color="yellow">{' \u2192 '}</Text>
                        <Text color="magenta" bold>@{arrow.to}</Text>
                        {i < arrows.length - 1 && <Text color="gray">{' \u2502'}</Text>}
                    </Box>
                ))}
            </Box>
        </Box>
    );
}

function ActivityLog({ entries }: { entries: LogEntry[] }) {
    const visible = entries.slice(-12);
    return (
        <Box flexDirection="column" marginTop={1}>
            <Text bold color="white">{'\u2630'} Activity</Text>
            <Text color="gray">{'\u2500'.repeat(72)}</Text>
            {visible.length === 0 ? (
                <Text color="gray" italic>  Waiting for events... (send a message to a team)</Text>
            ) : (
                visible.map((entry, i) => (
                    <Box key={i}>
                        <Text color="gray">{entry.time} </Text>
                        <Text>{entry.icon} </Text>
                        <Text color={entry.color as any}>{entry.text}</Text>
                    </Box>
                ))
            )}
        </Box>
    );
}

function StatusBar({ queueDepth, totalProcessed, processorAlive }: { queueDepth: number; totalProcessed: number; processorAlive: boolean }) {
    const sep = '\u2502';
    return (
        <Box flexDirection="column" marginTop={1}>
            <Text color="gray">{'\u2500'.repeat(72)}</Text>
            <Box gap={2}>
                {processorAlive ? (
                    <Text color="green">{'\u25CF'} Queue Processor Online</Text>
                ) : (
                    <Text color="yellow">{'\u25CB'} Queue Processor Idle</Text>
                )}
                <Text color="gray">{sep}</Text>
                <Text color="white">Queue: <Text color={queueDepth > 0 ? 'yellow' : 'green'}>{queueDepth}</Text></Text>
                <Text color="gray">{sep}</Text>
                <Text color="white">Processed: <Text color="cyan">{totalProcessed}</Text></Text>
                <Text color="gray">{sep}</Text>
                <Text dimColor>q to quit</Text>
            </Box>
        </Box>
    );
}

// ─── Trading-Specific Components ────────────────────────────────────────────

const REGIME_COLOR: Record<string, string> = {
    RALLY: 'green',
    SELLOFF: 'red',
    NEUTRAL: 'yellow',
};

function TradingPanel({ trading }: { trading: TradingState }) {
    const sep = '\u2502';
    return (
        <Box flexDirection="column" marginY={1}>
            <Text bold color="white">{'\u2636'} Trading Status</Text>
            <Text color="gray">{'\u2500'.repeat(72)}</Text>

            {/* Regime row */}
            <Box gap={2}>
                <Text color="gray">Regime:</Text>
                {trading.regime ? (
                    <>
                        <Text color={REGIME_COLOR[trading.regime.regime] || 'white'} bold>
                            {trading.regime.regime}
                        </Text>
                        <Text color="gray">{sep}</Text>
                        <Text color="white">BTC ${trading.regime.btcPrice.toLocaleString()}</Text>
                        <Text color={trading.regime.btc24h >= 0 ? 'green' : 'red'}>
                            {' '}{trading.regime.btc24h >= 0 ? '+' : ''}{trading.regime.btc24h.toFixed(1)}%
                        </Text>
                        <Text color="gray">{sep}</Text>
                        <Text color="white">ETH ${trading.regime.ethPrice.toLocaleString()}</Text>
                        <Text color={trading.regime.eth24h >= 0 ? 'green' : 'red'}>
                            {' '}{trading.regime.eth24h >= 0 ? '+' : ''}{trading.regime.eth24h.toFixed(1)}%
                        </Text>
                        <Text color="gray">{sep}</Text>
                        <Text dimColor>{timeAgo(new Date(trading.regime.assessedAt).getTime())}</Text>
                    </>
                ) : (
                    <Text color="gray" italic>No assessment yet</Text>
                )}
            </Box>

            {/* Strategies row */}
            <Box gap={2}>
                <Text color="gray">Strategies:</Text>
                {trading.strategies.length === 0 ? (
                    <Text color="gray" italic>None active</Text>
                ) : (
                    trading.strategies.map((s, i) => (
                        <Box key={i}>
                            <Text color="cyan">{s.name}</Text>
                            <Text color="gray"> ({s.asset}/{s.direction})</Text>
                            <Text color={s.status === 'live' ? 'green' : s.status === 'paper' ? 'yellow' : 'gray'}>
                                {' '}{s.status}
                            </Text>
                            {i < trading.strategies.length - 1 && <Text color="gray">{' ' + sep + ' '}</Text>}
                        </Box>
                    ))
                )}
            </Box>

            {/* Performance row */}
            <Box gap={2}>
                <Text color="gray">Performance:</Text>
                {trading.performance ? (
                    <>
                        <Text color="white">{trading.performance.totalTrades} trades</Text>
                        <Text color="gray">{sep}</Text>
                        <Text color="yellow">{trading.performance.openPositions} open</Text>
                        <Text color="gray">{sep}</Text>
                        <Text color="white">
                            WR: <Text color={trading.performance.winRate !== null && trading.performance.winRate >= 50 ? 'green' : 'red'}>
                                {trading.performance.winRate !== null ? `${trading.performance.winRate.toFixed(1)}%` : 'N/A'}
                            </Text>
                        </Text>
                        <Text color="gray">{sep}</Text>
                        <Text color="white">
                            P&L: <Text color={trading.performance.pnl !== null && trading.performance.pnl >= 0 ? 'green' : 'red'}>
                                {trading.performance.pnl !== null ? `${trading.performance.pnl >= 0 ? '+' : ''}${trading.performance.pnl.toFixed(2)}%` : 'N/A'}
                            </Text>
                        </Text>
                        <Text color="gray">{sep}</Text>
                        <Text dimColor>{timeAgo(new Date(trading.performance.reviewedAt).getTime())}</Text>
                    </>
                ) : (
                    <Text color="gray" italic>No review yet</Text>
                )}
            </Box>

            {/* DB status row */}
            <Box gap={2}>
                <Text color="gray">Database:</Text>
                {trading.dbConnected === null ? (
                    <Text color="gray" italic>Checking...</Text>
                ) : trading.dbConnected ? (
                    <Text color="green">{'\u25CF'} Connected (CT120:5433)</Text>
                ) : (
                    <Text color="red">{'\u25CB'} Disconnected</Text>
                )}
            </Box>
        </Box>
    );
}

function HeartbeatBar({ agent }: { agent: AgentState }) {
    if (!agent.heartbeatInterval) return null;

    const now = Math.floor(Date.now() / 1000);
    const elapsed = agent.lastHeartbeat ? now - agent.lastHeartbeat : null;
    const remaining = elapsed !== null ? Math.max(0, agent.heartbeatInterval - elapsed) : null;
    const pct = elapsed !== null ? Math.min(1, elapsed / agent.heartbeatInterval) : 0;

    // 10-char progress bar
    const filled = Math.round(pct * 10);
    const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(10 - filled);
    const barColor = pct >= 0.9 ? 'yellow' : pct >= 1 ? 'red' : 'gray';

    return (
        <Box>
            <Text dimColor>{'\u2661'} </Text>
            <Text color={barColor}>{bar}</Text>
            <Text dimColor>
                {' '}{remaining !== null ? `${formatDuration(remaining)} left` : 'never'}
            </Text>
        </Box>
    );
}

function formatDuration(secs: number): string {
    if (secs < 60) return `${secs}s`;
    if (secs < 3600) return `${Math.floor(secs / 60)}m`;
    return `${Math.floor(secs / 3600)}h${Math.floor((secs % 3600) / 60)}m`;
}

// ─── State file reader helpers ──────────────────────────────────────────────

const PROJECT_ROOT = path.join(TINYCLAW_HOME, '..');
const STATE_DIR = path.join(PROJECT_ROOT, 'state');
const HEARTBEAT_STATE_DIR = path.join(TINYCLAW_HOME, 'heartbeat-state');

function loadTradingState(): TradingState {
    const state: TradingState = { regime: null, strategies: [], performance: null, dbConnected: null };

    try {
        const raw = fs.readFileSync(path.join(STATE_DIR, 'market-regime.json'), 'utf8');
        const data = JSON.parse(raw);
        state.regime = {
            regime: data.regime || 'NEUTRAL',
            btcPrice: data.btc_price || 0,
            btc24h: data.btc_24h_change || 0,
            ethPrice: data.eth_price || 0,
            eth24h: data.eth_24h_change || 0,
            confidence: data.confidence || 0,
            assessedAt: data.assessed_at || '',
        };
    } catch { /* no regime file */ }

    try {
        const raw = fs.readFileSync(path.join(STATE_DIR, 'active-strategies.json'), 'utf8');
        const data = JSON.parse(raw);
        state.strategies = (data.strategies || []).map((s: any) => ({
            id: s.strategy_id,
            name: s.name,
            asset: s.asset,
            direction: s.direction,
            status: s.status,
        }));
    } catch { /* no strategies file */ }

    try {
        const raw = fs.readFileSync(path.join(STATE_DIR, 'performance-log.json'), 'utf8');
        const data = JSON.parse(raw);
        state.performance = {
            totalTrades: data.total_trades || 0,
            openPositions: data.open_positions || 0,
            winRate: data.win_rate ?? null,
            pnl: data.total_pnl_pct ?? null,
            reviewedAt: data.reviewed_at || '',
        };
    } catch { /* no performance file */ }

    return state;
}

function loadHeartbeatState(agentId: string): number | undefined {
    try {
        const raw = fs.readFileSync(path.join(HEARTBEAT_STATE_DIR, `${agentId}.last`), 'utf8');
        return parseInt(raw.trim(), 10) || undefined;
    } catch {
        return undefined;
    }
}

function checkDbConnection(): boolean {
    try {
        // Use execSync with fixed args only (no user input)
        execSync('pg_isready -h 192.168.68.120 -p 5433 -U trading_app -d trading -t 2', {
            stdio: 'ignore',
            timeout: 3000,
        });
        return true;
    } catch {
        return false;
    }
}

// ─── Main App ───────────────────────────────────────────────────────────────

function App({ filterTeamId }: { filterTeamId: string | null }) {
    const { exit } = useApp();
    const [settings, setSettings] = useState(() => loadSettings());
    const [agentStates, setAgentStates] = useState<Record<string, AgentState>>({});
    const [arrows, setArrows] = useState<ChainArrow[]>([]);
    const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
    const [totalProcessed, setTotalProcessed] = useState(0);
    const [queueDepth, setQueueDepth] = useState(0);
    const [processorAlive, setProcessorAlive] = useState(false);
    const [startTime] = useState(Date.now());
    const [, setTick] = useState(0);
    const [tradingState, setTradingState] = useState<TradingState>(() => loadTradingState());

    // Force re-render every second for animated dots and uptime
    useEffect(() => {
        const timer = setInterval(() => setTick(t => t + 1), 500);
        return () => clearInterval(timer);
    }, []);

    useInput((input: string) => {
        if (input === 'q' || input === 'Q') {
            exit();
        }
    }, { isActive: process.stdin.isTTY === true });

    // Initialize agent states from settings
    useEffect(() => {
        const { agents, teams } = settings;
        const states: Record<string, AgentState> = {};

        // Determine which agents to show
        let agentIds: string[];
        if (filterTeamId && teams[filterTeamId]) {
            agentIds = teams[filterTeamId].agents;
        } else {
            // Show all agents that belong to any team
            const teamAgentIds = new Set<string>();
            for (const team of Object.values(teams)) {
                for (const aid of team.agents) teamAgentIds.add(aid);
            }
            agentIds = teamAgentIds.size > 0 ? Array.from(teamAgentIds) : Object.keys(agents);
        }

        for (const id of agentIds) {
            const agent = agents[id];
            if (agent) {
                states[id] = {
                    id,
                    name: agent.name,
                    provider: agent.provider || 'anthropic',
                    model: agent.model || 'sonnet',
                    status: 'idle',
                    lastActivity: '',
                    lastHeartbeat: loadHeartbeatState(id),
                    heartbeatInterval: (agent as any).heartbeat_interval || undefined,
                };
            }
        }
        setAgentStates(states);
    }, [settings, filterTeamId]);

    // Poll trading state files + heartbeat state every 10s
    useEffect(() => {
        const interval = setInterval(() => {
            setTradingState(loadTradingState());
            // Update heartbeat timestamps on existing agent states
            setAgentStates(prev => {
                const updated = { ...prev };
                let changed = false;
                for (const id of Object.keys(updated)) {
                    const hb = loadHeartbeatState(id);
                    if (hb !== updated[id].lastHeartbeat) {
                        updated[id] = { ...updated[id], lastHeartbeat: hb };
                        changed = true;
                    }
                }
                return changed ? updated : prev;
            });
        }, 10_000);
        return () => clearInterval(interval);
    }, []);

    // Check DB connection every 30s
    useEffect(() => {
        // Initial check
        setTradingState(prev => ({ ...prev, dbConnected: checkDbConnection() }));
        const interval = setInterval(() => {
            setTradingState(prev => ({ ...prev, dbConnected: checkDbConnection() }));
        }, 30_000);
        return () => clearInterval(interval);
    }, []);

    // Add a log entry helper
    const addLog = useCallback((icon: string, text: string, color: string) => {
        setLogEntries(prev => {
            const entry: LogEntry = { time: shortTime(Date.now()), icon, text, color };
            const next = [...prev, entry];
            return next.length > 50 ? next.slice(-50) : next;
        });
    }, []);

    // Process a single event
    const handleEvent = useCallback((event: TinyClawEvent) => {
        switch (event.type) {
            case 'processor_start':
                setProcessorAlive(true);
                addLog('\u26A1', 'Queue processor started', 'green');
                // Refresh settings when processor starts
                setSettings(loadSettings());
                break;

            case 'message_received':
                addLog('\u2709', `[${event.channel}] ${event.sender}: ${truncate(String(event.message || ''), 50)}`, 'white');
                break;

            case 'agent_routed': {
                const aid = String(event.agentId);
                setAgentStates(prev => {
                    if (!prev[aid]) return prev;
                    return { ...prev, [aid]: { ...prev[aid], status: 'active' as AgentStatus, lastActivity: 'Routing...' } };
                });
                if (event.isTeamRouted) {
                    addLog('\u2691', `Routed to @${aid} (via team)`, 'cyan');
                } else {
                    addLog('\u2192', `Routed to @${aid}`, 'cyan');
                }
                break;
            }

            case 'team_chain_start':
                addLog('\u26D3', `Chain started: ${event.teamName} [${(event.agents as string[]).map(a => '@' + a).join(', ')}]`, 'magenta');
                setArrows([]);
                break;

            case 'chain_step_start': {
                const aid = String(event.agentId);
                setAgentStates(prev => {
                    const updated = { ...prev };
                    for (const key of Object.keys(updated)) {
                        if (key !== aid && updated[key].status === 'active') {
                            updated[key] = { ...updated[key], status: 'waiting' as AgentStatus };
                        }
                    }
                    if (updated[aid]) {
                        updated[aid] = { ...updated[aid], status: 'active' as AgentStatus, lastActivity: `Step ${event.step}` };
                    }
                    return updated;
                });
                break;
            }

            case 'chain_step_done': {
                const aid = String(event.agentId);
                setAgentStates(prev => {
                    if (!prev[aid]) return prev;
                    return { ...prev, [aid]: { ...prev[aid], status: 'done' as AgentStatus, responseLength: event.responseLength as number } };
                });
                const text = event.responseText ? String(event.responseText) : `(${event.responseLength} chars)`;
                addLog('\u{1F4AC}', `@${aid}: ${text}`, 'white');
                break;
            }

            case 'chain_handoff': {
                const from = String(event.fromAgent);
                const to = String(event.toAgent);
                setArrows(prev => [...prev, { from, to, step: event.step as number, timestamp: event.timestamp }]);
                setAgentStates(prev => {
                    const updated = { ...prev };
                    if (updated[to]) {
                        updated[to] = { ...updated[to], status: 'waiting' as AgentStatus, lastActivity: `Handoff from @${from}` };
                    }
                    return updated;
                });
                addLog('\u2192', `@${from} \u2192 @${to}`, 'yellow');
                break;
            }

            case 'team_chain_end': {
                const chainAgents = event.agents as string[];
                addLog('\u2714', `Chain complete [${chainAgents.map(a => '@' + a).join(' \u2192 ')}]`, 'green');
                setAgentStates(prev => {
                    const updated = { ...prev };
                    for (const aid of chainAgents) {
                        if (updated[aid]) {
                            updated[aid] = { ...updated[aid], status: 'done' as AgentStatus };
                        }
                    }
                    return updated;
                });
                break;
            }

            case 'response_ready':
                setTotalProcessed(prev => prev + 1);
                // Reset agent states to idle after a short delay via next tick
                setTimeout(() => {
                    setAgentStates(prev => {
                        const updated = { ...prev };
                        for (const key of Object.keys(updated)) {
                            if (updated[key].status === 'done' || updated[key].status === 'error') {
                                updated[key] = { ...updated[key], status: 'idle' as AgentStatus, lastActivity: timeAgo(Date.now()) };
                            }
                        }
                        return updated;
                    });
                    setArrows([]);
                }, 3000);
                break;
        }
    }, [addLog]);

    // Watch events directory
    useEffect(() => {
        if (!fs.existsSync(EVENTS_DIR)) {
            fs.mkdirSync(EVENTS_DIR, { recursive: true });
        }

        // Track processed files to avoid duplicates
        const processed = new Set<string>();

        // Process existing events from the last 30 seconds (catch recent activity)
        const cutoff = Date.now() - 30_000;
        try {
            const existing = fs.readdirSync(EVENTS_DIR)
                .filter(f => f.endsWith('.json'))
                .sort();
            for (const file of existing) {
                try {
                    const content = fs.readFileSync(path.join(EVENTS_DIR, file), 'utf8');
                    const event: TinyClawEvent = JSON.parse(content.trim());
                    if (event.timestamp >= cutoff) {
                        handleEvent(event);
                    }
                    processed.add(file);
                } catch { /* skip malformed */ }
            }
        } catch { /* dir might not exist yet */ }

        // Watch for new events
        let watcher: fs.FSWatcher | null = null;
        try {
            watcher = fs.watch(EVENTS_DIR, (eventType, filename) => {
                if (!filename || !filename.endsWith('.json') || processed.has(filename)) return;
                processed.add(filename);
                const filePath = path.join(EVENTS_DIR, filename);
                // Small delay to ensure file is fully written
                setTimeout(() => {
                    try {
                        const content = fs.readFileSync(filePath, 'utf8');
                        const event: TinyClawEvent = JSON.parse(content.trim());
                        handleEvent(event);
                    } catch { /* skip */ }
                    // Clean up old event files (older than 60s)
                    try { fs.unlinkSync(filePath); } catch { /* already gone */ }
                }, 50);
            });
        } catch { /* watch failed */ }

        return () => { watcher?.close(); };
    }, [handleEvent]);

    // Poll queue depth
    useEffect(() => {
        const queueIncoming = path.join(TINYCLAW_HOME, 'queue/incoming');
        const interval = setInterval(() => {
            try {
                const files = fs.existsSync(queueIncoming) ? fs.readdirSync(queueIncoming).filter(f => f.endsWith('.json')) : [];
                setQueueDepth(files.length);
            } catch {
                setQueueDepth(0);
            }
        }, 1000);
        return () => clearInterval(interval);
    }, []);

    // Detect if processor is alive (check if process is running)
    useEffect(() => {
        const interval = setInterval(() => {
            try {
                execSync('pgrep -f "queue-processor"', { stdio: 'ignore' });
                setProcessorAlive(true);
            } catch {
                setProcessorAlive(false);
            }
        }, 5000);
        return () => clearInterval(interval);
    }, []);

    // Determine current team info
    const teamId = filterTeamId;
    const teamName = teamId && settings.teams[teamId] ? settings.teams[teamId].name : null;
    const leaderAgent = teamId && settings.teams[teamId] ? settings.teams[teamId].leader_agent : null;

    const uptime = timeAgo(startTime);
    const agentList = Object.values(agentStates);

    return (
        <Box flexDirection="column" paddingX={1}>
            <Header teamId={teamId} teamName={teamName} uptime={`up ${uptime}`} />

            {/* Team topology */}
            {Object.keys(settings.teams).length === 0 ? (
                <Box flexDirection="column" marginBottom={1}>
                    <Text color="yellow">No teams configured.</Text>
                    <Text color="gray">Create a team with: tinyclaw team add</Text>
                </Box>
            ) : (
                <>
                    {/* Agent cards */}
                    <Box flexDirection="row" gap={1} flexWrap="wrap">
                        {agentList.map(agent => (
                            <AgentCard
                                key={agent.id}
                                agent={agent}
                                isLeader={agent.id === leaderAgent}
                            />
                        ))}
                    </Box>

                    {/* Chain flow arrows */}
                    <ChainFlow arrows={arrows} agents={agentStates} />

                    {/* Team legend when viewing all teams */}
                    {!filterTeamId && Object.keys(settings.teams).length > 0 && (
                        <Box flexDirection="column" marginTop={1}>
                            <Text bold color="white">{'\u2263'} Teams</Text>
                            {Object.entries(settings.teams).map(([id, team]) => (
                                <Box key={id}>
                                    <Text color="cyan" bold>  @{id}</Text>
                                    <Text color="gray"> {team.name} </Text>
                                    <Text color="gray">[{team.agents.map(a => '@' + a).join(', ')}]</Text>
                                    <Text color="yellow"> {'\u2605'} @{team.leader_agent}</Text>
                                </Box>
                            ))}
                        </Box>
                    )}
                </>
            )}

            {/* Trading status panel */}
            <TradingPanel trading={tradingState} />

            {/* Activity log */}
            <ActivityLog entries={logEntries} />

            {/* Status bar */}
            <StatusBar queueDepth={queueDepth} totalProcessed={totalProcessed} processorAlive={processorAlive} />
        </Box>
    );
}

// ─── Entry point ────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
let filterTeamId: string | null = null;

for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--team' || args[i] === '-t') && args[i + 1]) {
        filterTeamId = args[i + 1];
        i++;
    }
}

render(<App filterTeamId={filterTeamId} />);
