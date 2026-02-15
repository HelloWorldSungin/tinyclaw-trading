export interface AgentConfig {
    name: string;
    provider: string;       // 'anthropic' or 'openai'
    model: string;           // e.g. 'sonnet', 'opus', 'gpt-5.3-codex'
    working_directory: string;
    invoke_mode?: 'local' | 'remote';   // default: 'local'
    remote_host?: string;               // SSH host for remote invocation
    remote_user?: string;               // SSH user for remote invocation
    remote_project_root?: string;       // project root on remote host
    heartbeat_interval?: number;        // per-agent interval in seconds (overrides global)
    heartbeat_schedule?: number[];      // clock-aligned minutes-of-hour to fire (e.g. [15, 45])
    heartbeat_mode?: 'claude' | 'script'; // 'script' = no Claude spawn, run heartbeat.sh instead
}

export interface TeamConfig {
    name: string;
    agents: string[];
    leader_agent: string;
}

export interface ChainStep {
    agentId: string;
    response: string;
}

export interface Settings {
    workspace?: {
        path?: string;
        name?: string;
    };
    channels?: {
        enabled?: string[];
        discord?: {
            bot_token?: string;
            user_id?: string;       // authorized Discord user ID (fail-closed auth)
            channel_id?: string;    // server channel for plain text messages
            webhook_url?: string;   // webhook for heartbeat/cron notifications
        };
    };
    models?: {
        provider?: string; // 'anthropic' or 'openai'
        anthropic?: {
            model?: string;
        };
        openai?: {
            model?: string;
        };
    };
    agents?: Record<string, AgentConfig>;
    teams?: Record<string, TeamConfig>;
    monitoring?: {
        heartbeat_interval?: number;
    };
}

export interface MessageData {
    channel: string;
    sender: string;
    senderId?: string;
    message: string;
    timestamp: number;
    messageId: string;
    agent?: string; // optional: pre-routed agent id from channel client
    command?: string; // slash command name if from a slash command
    files?: string[];
}

export interface ResponseData {
    channel: string;
    sender: string;
    message: string;
    originalMessage: string;
    timestamp: number;
    messageId: string;
    agent?: string; // which agent handled this
    files?: string[];
}

export interface QueueFile {
    name: string;
    path: string;
    time: number;
}

// Model name mapping
export const CLAUDE_MODEL_IDS: Record<string, string> = {
    'sonnet': 'claude-sonnet-4-5',
    'opus': 'claude-opus-4-6',
    'claude-sonnet-4-5': 'claude-sonnet-4-5',
    'claude-opus-4-6': 'claude-opus-4-6'
};

export const CODEX_MODEL_IDS: Record<string, string> = {
    'gpt-5.2': 'gpt-5.2',
    'gpt-5.3-codex': 'gpt-5.3-codex',
};
