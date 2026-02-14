#!/usr/bin/env bun
/**
 * Discord Client for TinyClaw Trading
 * Handles DMs, server channel messages, and slash commands.
 * Writes to queue, reads responses. Does NOT call Claude directly.
 *
 * Slash commands:
 *   /status     — Instant status (no Claude)
 *   /help       — Show available commands (no Claude)
 *   /reset      — Reset conversation (no Claude)
 *   /regime     — Fresh regime analysis → regime-analyst
 *   /performance — Trade review → trade-reviewer
 *   /strategies — List strategies → strategist
 *   /activate   — Activate strategy → strategist
 *   /research   — Backtest on CT110 → researcher
 *   /ask        — Free-form question → strategist
 */

import {
    Client, Events, GatewayIntentBits, Partials,
    Message, DMChannel, TextChannel, AttachmentBuilder,
    REST, Routes, SlashCommandBuilder,
    ChatInputCommandInteraction,
} from 'discord.js';
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import os from 'os';

import {
    handleStatusCommand,
    handleHelpCommand,
    buildRegimePrompt,
    buildPerformancePrompt,
    buildStrategiesPrompt,
    buildActivatePrompt,
    buildAskPrompt,
    buildResearchCommandPrompt,
    checkRateLimit,
} from '../plugins/trading-commands/handlers';

// Bun: use import.meta.dir instead of __dirname
const SCRIPT_DIR = path.resolve(import.meta.dir, '../..');
const _localTinyclaw = path.join(SCRIPT_DIR, '.tinyclaw');
const TINYCLAW_HOME = fs.existsSync(path.join(_localTinyclaw, 'settings.json'))
    ? _localTinyclaw
    : path.join(os.homedir(), '.tinyclaw');
const QUEUE_INCOMING = path.join(TINYCLAW_HOME, 'queue/incoming');
const QUEUE_OUTGOING = path.join(TINYCLAW_HOME, 'queue/outgoing');
const LOG_FILE = path.join(TINYCLAW_HOME, 'logs/discord.log');
const SETTINGS_FILE = path.join(TINYCLAW_HOME, 'settings.json');
const FILES_DIR = path.join(TINYCLAW_HOME, 'files');

// Ensure directories exist
[QUEUE_INCOMING, QUEUE_OUTGOING, path.dirname(LOG_FILE), FILES_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

// Validate bot token
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
if (!DISCORD_BOT_TOKEN || DISCORD_BOT_TOKEN === 'your_token_here') {
    console.error('ERROR: DISCORD_BOT_TOKEN is not set in .env file');
    process.exit(1);
}

// Load auth settings
function loadSettings(): any {
    try {
        return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    } catch {
        return {};
    }
}

// Authorization: fail-closed — reject if user_id not set or doesn't match
function isAuthorized(userId: string): boolean {
    const settings = loadSettings();
    const allowedUserId = settings?.channels?.discord?.user_id || process.env.DISCORD_USER_ID;
    if (!allowedUserId) {
        throw new Error('DISCORD_USER_ID not set — refusing all requests (fail-closed)');
    }
    return userId === allowedUserId;
}

// Get configured channel ID for server messages
function getChannelId(): string | undefined {
    const settings = loadSettings();
    return settings?.channels?.discord?.channel_id || process.env.DISCORD_CHANNEL_ID;
}

// ============================================================
// PENDING RESPONSE TRACKING
// Supports both regular messages and slash command interactions
// ============================================================

interface PendingResponse {
    type: 'message' | 'interaction';
    message?: Message;
    interaction?: ChatInputCommandInteraction;
    channel?: DMChannel | TextChannel;
    timestamp: number;
}

interface QueueData {
    channel: string;
    sender: string;
    senderId: string;
    message: string;
    timestamp: number;
    messageId: string;
    agent?: string;
    command?: string;
    files?: string[];
}

interface ResponseData {
    channel: string;
    sender: string;
    message: string;
    originalMessage: string;
    timestamp: number;
    messageId: string;
    files?: string[];
}

const pendingResponses = new Map<string, PendingResponse>();
let processingOutgoingQueue = false;

// Logger
function log(level: string, message: string): void {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [${level}] ${message}\n`;
    console.log(logMessage.trim());
    fs.appendFileSync(LOG_FILE, logMessage);
}

// ============================================================
// SLASH COMMAND DEFINITIONS
// ============================================================

const slashCommands = [
    new SlashCommandBuilder()
        .setName('status')
        .setDescription('Quick status summary — instant, no Claude spawn'),
    new SlashCommandBuilder()
        .setName('help')
        .setDescription('Show available commands'),
    new SlashCommandBuilder()
        .setName('regime')
        .setDescription('Fresh market regime analysis (spawns Claude)'),
    new SlashCommandBuilder()
        .setName('performance')
        .setDescription('Trade performance review (spawns Claude)'),
    new SlashCommandBuilder()
        .setName('strategies')
        .setDescription('List all trading strategies (spawns Claude)'),
    new SlashCommandBuilder()
        .setName('activate')
        .setDescription('Activate a strategy for paper trading')
        .addStringOption(option =>
            option.setName('strategy_id')
                .setDescription('Strategy ID to activate')
                .setRequired(true)),
    new SlashCommandBuilder()
        .setName('research')
        .setDescription('Research & backtest a strategy on CT110')
        .addStringOption(option =>
            option.setName('query')
                .setDescription('Strategy description to research')
                .setRequired(true)),
    new SlashCommandBuilder()
        .setName('ask')
        .setDescription('Ask the strategist anything about trading')
        .addStringOption(option =>
            option.setName('question')
                .setDescription('Your question')
                .setRequired(true)),
    new SlashCommandBuilder()
        .setName('reset')
        .setDescription('Reset conversation — next message starts fresh'),
];

// ============================================================
// UTILITY FUNCTIONS
// ============================================================

function sanitizeFileName(fileName: string): string {
    const baseName = path.basename(fileName).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
    return baseName.length > 0 ? baseName : 'file.bin';
}

function buildUniqueFilePath(dir: string, preferredName: string): string {
    const cleanName = sanitizeFileName(preferredName);
    const ext = path.extname(cleanName);
    const stem = path.basename(cleanName, ext);
    let candidate = path.join(dir, cleanName);
    let counter = 1;
    while (fs.existsSync(candidate)) {
        candidate = path.join(dir, `${stem}_${counter}${ext}`);
        counter++;
    }
    return candidate;
}

async function downloadFile(url: string, destPath: string): Promise<void> {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = await response.arrayBuffer();
    fs.writeFileSync(destPath, Buffer.from(buffer));
}

// Load teams from settings
function getTeamListText(): string {
    try {
        const settings = loadSettings();
        const teams = settings.teams;
        if (!teams || Object.keys(teams).length === 0) return 'No teams configured.';
        let text = '**Available Teams:**\n';
        for (const [id, team] of Object.entries(teams) as [string, any][]) {
            text += `\n**@${id}** - ${team.name}`;
            text += `\n  Agents: ${team.agents.join(', ')}`;
            text += `\n  Leader: @${team.leader_agent}`;
        }
        text += '\n\nUsage: Start your message with `@team_id` to route to a team.';
        return text;
    } catch {
        return 'Could not load team configuration.';
    }
}

// Load agents from settings
function getAgentListText(): string {
    try {
        const settings = loadSettings();
        const agents = settings.agents;
        if (!agents || Object.keys(agents).length === 0) return 'No agents configured.';
        let text = '**Available Agents:**\n';
        for (const [id, agent] of Object.entries(agents) as [string, any][]) {
            text += `\n**@${id}** - ${agent.name}`;
            text += `\n  Provider: ${agent.provider}/${agent.model}`;
        }
        text += '\n\nUsage: Start your message with `@agent_id` to route to a specific agent.';
        return text;
    } catch {
        return 'Could not load agent configuration.';
    }
}

function splitMessage(text: string, maxLength = 2000): string[] {
    if (text.length <= maxLength) return [text];
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
        if (remaining.length <= maxLength) {
            chunks.push(remaining);
            break;
        }
        let splitIndex = remaining.lastIndexOf('\n', maxLength);
        if (splitIndex <= 0) splitIndex = remaining.lastIndexOf(' ', maxLength);
        if (splitIndex <= 0) splitIndex = maxLength;
        chunks.push(remaining.substring(0, splitIndex));
        remaining = remaining.substring(splitIndex).replace(/^\n/, '');
    }
    return chunks;
}

function generateMessageId(): string {
    return `${Date.now()}_${Math.random().toString(36).substring(7)}`;
}

/**
 * Write a queue message for a Claude-spawning command.
 * Returns the messageId for tracking the pending response.
 */
function writeQueueMessage(opts: {
    sender: string;
    senderId: string;
    message: string;
    agent: string;
    command: string;
}): string {
    const messageId = generateMessageId();
    const queueData: QueueData = {
        channel: 'discord',
        sender: opts.sender,
        senderId: opts.senderId,
        message: opts.message,
        timestamp: Date.now(),
        messageId,
        agent: opts.agent,
        command: opts.command,
    };
    const queueFile = path.join(QUEUE_INCOMING, `discord_${messageId}.json`);
    fs.writeFileSync(queueFile, JSON.stringify(queueData, null, 2));
    log('INFO', `Queued ${opts.command} → @${opts.agent} [${messageId}]`);
    return messageId;
}

function cleanOldPending(): void {
    const tenMinutesAgo = Date.now() - (10 * 60 * 1000);
    for (const [id, data] of pendingResponses.entries()) {
        if (data.timestamp < tenMinutesAgo) {
            pendingResponses.delete(id);
        }
    }
}

// ============================================================
// DISCORD CLIENT
// ============================================================

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
    ],
    partials: [
        Partials.Channel,
        Partials.Message,
    ],
});

// ============================================================
// CLIENT READY — Register slash commands
// ============================================================

client.on(Events.ClientReady, async (readyClient) => {
    log('INFO', `Discord bot connected as ${readyClient.user.tag}`);

    // Register slash commands globally
    try {
        const rest = new REST().setToken(DISCORD_BOT_TOKEN);
        const commandData = slashCommands.map(cmd => cmd.toJSON());
        await rest.put(
            Routes.applicationCommands(readyClient.user.id),
            { body: commandData },
        );
        log('INFO', `Registered ${commandData.length} slash commands`);
    } catch (error) {
        log('ERROR', `Failed to register slash commands: ${(error as Error).message}`);
    }

    log('INFO', 'Listening for DMs, server messages, and slash commands...');
});

// ============================================================
// SLASH COMMAND HANDLER
// ============================================================

client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const command = interaction as ChatInputCommandInteraction;
    const userId = command.user.id;
    const sender = command.user.username;

    // Authorization check
    try {
        if (!isAuthorized(userId)) {
            await command.reply({ content: 'Unauthorized.', ephemeral: true });
            return;
        }
    } catch (e) {
        log('ERROR', `Auth error: ${(e as Error).message}`);
        await command.reply({ content: 'Authorization not configured.', ephemeral: true });
        return;
    }

    log('INFO', `Slash command /${command.commandName} from ${sender}`);

    try {
        switch (command.commandName) {
            // ---- INSTANT COMMANDS (no Claude) ----

            case 'status': {
                await command.deferReply();
                const statusText = await handleStatusCommand();
                await command.editReply(statusText);
                return;
            }

            case 'help': {
                const helpText = await handleHelpCommand();
                await command.reply(helpText);
                return;
            }

            // ---- CLAUDE-SPAWNING COMMANDS ----

            case 'regime': {
                if (!checkRateLimit()) {
                    await command.reply({ content: 'Rate limited. Try again in a minute.', ephemeral: true });
                    return;
                }
                await command.deferReply();
                const prompt = await buildRegimePrompt();
                const msgId = writeQueueMessage({
                    sender, senderId: userId, message: prompt,
                    agent: 'regime-analyst', command: '/regime',
                });
                pendingResponses.set(msgId, { type: 'interaction', interaction: command, timestamp: Date.now() });
                cleanOldPending();
                return;
            }

            case 'performance': {
                if (!checkRateLimit()) {
                    await command.reply({ content: 'Rate limited. Try again in a minute.', ephemeral: true });
                    return;
                }
                await command.deferReply();
                const prompt = await buildPerformancePrompt();
                const msgId = writeQueueMessage({
                    sender, senderId: userId, message: prompt,
                    agent: 'trade-reviewer', command: '/performance',
                });
                pendingResponses.set(msgId, { type: 'interaction', interaction: command, timestamp: Date.now() });
                cleanOldPending();
                return;
            }

            case 'strategies': {
                if (!checkRateLimit()) {
                    await command.reply({ content: 'Rate limited. Try again in a minute.', ephemeral: true });
                    return;
                }
                await command.deferReply();
                const prompt = await buildStrategiesPrompt();
                const msgId = writeQueueMessage({
                    sender, senderId: userId, message: prompt,
                    agent: 'strategist', command: '/strategies',
                });
                pendingResponses.set(msgId, { type: 'interaction', interaction: command, timestamp: Date.now() });
                cleanOldPending();
                return;
            }

            case 'activate': {
                const strategyId = command.options.getString('strategy_id', true);
                if (!checkRateLimit()) {
                    await command.reply({ content: 'Rate limited. Try again in a minute.', ephemeral: true });
                    return;
                }
                await command.deferReply();
                const result = await buildActivatePrompt(strategyId);
                if (result.error) {
                    await command.editReply(result.error);
                    return;
                }
                const msgId = writeQueueMessage({
                    sender, senderId: userId, message: result.prompt,
                    agent: 'strategist', command: '/activate',
                });
                pendingResponses.set(msgId, { type: 'interaction', interaction: command, timestamp: Date.now() });
                cleanOldPending();
                return;
            }

            case 'research': {
                const query = command.options.getString('query', true);
                if (!checkRateLimit()) {
                    await command.reply({ content: 'Rate limited. Try again in a minute.', ephemeral: true });
                    return;
                }
                await command.deferReply();
                try {
                    const prompt = await buildResearchCommandPrompt(query);
                    const msgId = writeQueueMessage({
                        sender, senderId: userId, message: prompt,
                        agent: 'researcher', command: '/research',
                    });
                    pendingResponses.set(msgId, { type: 'interaction', interaction: command, timestamp: Date.now() });
                } catch (e) {
                    await command.editReply((e as Error).message);
                }
                cleanOldPending();
                return;
            }

            case 'ask': {
                const question = command.options.getString('question', true);
                if (!checkRateLimit()) {
                    await command.reply({ content: 'Rate limited. Try again in a minute.', ephemeral: true });
                    return;
                }
                await command.deferReply();
                try {
                    const prompt = await buildAskPrompt(question);
                    const msgId = writeQueueMessage({
                        sender, senderId: userId, message: prompt,
                        agent: 'strategist', command: '/ask',
                    });
                    pendingResponses.set(msgId, { type: 'interaction', interaction: command, timestamp: Date.now() });
                } catch (e) {
                    await command.editReply((e as Error).message);
                }
                cleanOldPending();
                return;
            }

            case 'reset': {
                fs.writeFileSync(path.join(TINYCLAW_HOME, 'reset_flag'), 'reset');
                await command.reply({ content: 'Conversation reset! Next message will start a fresh conversation.', ephemeral: true });
                return;
            }

            default:
                await command.reply({ content: `Unknown command: /${command.commandName}`, ephemeral: true });
        }
    } catch (error) {
        log('ERROR', `Slash command error (/${command.commandName}): ${(error as Error).message}`);
        try {
            if (command.deferred) {
                await command.editReply('An error occurred processing your command.');
            } else {
                await command.reply({ content: 'An error occurred.', ephemeral: true });
            }
        } catch { /* reply already sent */ }
    }
});

// ============================================================
// PLAIN MESSAGE HANDLER (DMs + server channel text)
// ============================================================

client.on(Events.MessageCreate, async (message: Message) => {
    try {
        if (message.author.bot) return;

        try {
            if (!isAuthorized(message.author.id)) return;
        } catch (e) {
            log('ERROR', `Auth error: ${(e as Error).message}`);
            return;
        }

        // For server messages, check channel ID
        const channelId = getChannelId();
        if (message.guild && channelId && message.channel.id !== channelId) return;

        const hasAttachments = message.attachments.size > 0;
        const hasContent = message.content && message.content.trim().length > 0;
        if (!hasContent && !hasAttachments) return;

        const sender = message.author.username;
        const messageId = generateMessageId();
        let messageText = message.content || '';

        // Quick text commands (no slash)
        if (messageText.trim().match(/^[!/]agent$/i)) {
            await message.reply(getAgentListText());
            return;
        }
        if (messageText.trim().match(/^[!/]team$/i)) {
            await message.reply(getTeamListText());
            return;
        }
        if (messageText.trim().match(/^[!/]reset$/i)) {
            fs.writeFileSync(path.join(TINYCLAW_HOME, 'reset_flag'), 'reset');
            await message.reply('Conversation reset! Next message will start a fresh conversation.');
            return;
        }

        log('INFO', `Message from ${sender}: ${messageText.substring(0, 50)}...`);

        // Download attachments
        const downloadedFiles: string[] = [];
        if (hasAttachments) {
            for (const [, attachment] of message.attachments) {
                try {
                    const attachmentName = attachment.name || `discord_${messageId}_${Date.now()}.bin`;
                    const filename = `discord_${messageId}_${attachmentName}`;
                    const localPath = buildUniqueFilePath(FILES_DIR, filename);
                    await downloadFile(attachment.url, localPath);
                    downloadedFiles.push(localPath);
                    log('INFO', `Downloaded attachment: ${path.basename(localPath)}`);
                } catch (dlErr) {
                    log('ERROR', `Failed to download attachment: ${(dlErr as Error).message}`);
                }
            }
        }

        // Show typing indicator
        const typingChannel = message.channel as (DMChannel | TextChannel);
        await typingChannel.sendTyping();

        // Build full message
        let fullMessage = messageText;
        if (downloadedFiles.length > 0) {
            const fileRefs = downloadedFiles.map(f => `[file: ${f}]`).join('\n');
            fullMessage = fullMessage ? `${fullMessage}\n\n${fileRefs}` : fileRefs;
        }

        // Write to queue (no pre-routed agent — queue processor handles routing via @mentions)
        const queueData: QueueData = {
            channel: 'discord',
            sender,
            senderId: message.author.id,
            message: fullMessage,
            timestamp: Date.now(),
            messageId,
            files: downloadedFiles.length > 0 ? downloadedFiles : undefined,
        };

        const queueFile = path.join(QUEUE_INCOMING, `discord_${messageId}.json`);
        fs.writeFileSync(queueFile, JSON.stringify(queueData, null, 2));
        log('INFO', `Queued message ${messageId}`);

        // Store pending response
        pendingResponses.set(messageId, {
            type: 'message',
            message,
            channel: typingChannel,
            timestamp: Date.now(),
        });
        cleanOldPending();

    } catch (error) {
        log('ERROR', `Message handling error: ${(error as Error).message}`);
    }
});

// ============================================================
// OUTGOING QUEUE WATCHER
// ============================================================

async function checkOutgoingQueue(): Promise<void> {
    if (processingOutgoingQueue) return;
    processingOutgoingQueue = true;

    try {
        const files = fs.readdirSync(QUEUE_OUTGOING)
            .filter(f => f.startsWith('discord_') && f.endsWith('.json'));

        for (const file of files) {
            const filePath = path.join(QUEUE_OUTGOING, file);

            try {
                const responseData: ResponseData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                const { messageId, message: responseText, sender } = responseData;

                const pending = pendingResponses.get(messageId);
                if (!pending) {
                    log('WARN', `No pending response for ${messageId}, cleaning up`);
                    fs.unlinkSync(filePath);
                    continue;
                }

                // Prepare file attachments
                const attachments: AttachmentBuilder[] = [];
                if (responseData.files && responseData.files.length > 0) {
                    for (const f of responseData.files) {
                        try {
                            if (fs.existsSync(f)) attachments.push(new AttachmentBuilder(f));
                        } catch (fileErr) {
                            log('ERROR', `Failed to prepare file ${f}: ${(fileErr as Error).message}`);
                        }
                    }
                }

                const chunks = responseText ? splitMessage(responseText) : [];

                if (pending.type === 'interaction' && pending.interaction) {
                    // Slash command response — use editReply
                    const interaction = pending.interaction;
                    try {
                        if (chunks.length > 0) {
                            await interaction.editReply({
                                content: chunks[0],
                                files: attachments.length > 0 ? attachments : undefined,
                            });
                        } else if (attachments.length > 0) {
                            await interaction.editReply({ content: 'Done.', files: attachments });
                        }
                        // Send overflow chunks as follow-up messages
                        for (let i = 1; i < chunks.length; i++) {
                            await interaction.followUp(chunks[i]!);
                        }
                    } catch (interactionErr) {
                        log('ERROR', `Interaction reply error: ${(interactionErr as Error).message}`);
                    }
                } else if (pending.type === 'message' && pending.message && pending.channel) {
                    // Regular message response — use reply
                    if (attachments.length > 0) {
                        await pending.channel.send({ files: attachments });
                    }
                    if (chunks.length > 0) {
                        await pending.message.reply(chunks[0]!);
                    }
                    for (let i = 1; i < chunks.length; i++) {
                        await pending.channel.send(chunks[i]!);
                    }
                }

                log('INFO', `Sent response to ${sender} (${responseText.length} chars)`);
                pendingResponses.delete(messageId);
                fs.unlinkSync(filePath);

            } catch (error) {
                log('ERROR', `Error processing response file ${file}: ${(error as Error).message}`);
            }
        }
    } catch (error) {
        log('ERROR', `Outgoing queue error: ${(error as Error).message}`);
    } finally {
        processingOutgoingQueue = false;
    }
}

// Check outgoing queue every second
setInterval(checkOutgoingQueue, 1000);

// Refresh typing indicator every 8 seconds for pending messages (not interactions)
setInterval(() => {
    for (const [, data] of pendingResponses.entries()) {
        if (data.type === 'message' && data.channel) {
            data.channel.sendTyping().catch(() => {});
        }
    }
}, 8000);

// ============================================================
// GRACEFUL SHUTDOWN
// ============================================================

process.on('SIGINT', () => {
    log('INFO', 'Shutting down Discord client...');
    client.destroy();
    process.exit(0);
});

process.on('SIGTERM', () => {
    log('INFO', 'Shutting down Discord client...');
    client.destroy();
    process.exit(0);
});

// Start client
log('INFO', 'Starting TinyClaw Trading Discord client...');
client.login(DISCORD_BOT_TOKEN);
