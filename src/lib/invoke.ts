import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { AgentConfig, TeamConfig } from './types';
import { SCRIPT_DIR, resolveClaudeModel, resolveCodexModel } from './config';
import { log } from './logging';
import { ensureAgentDirectory, updateAgentTeammates } from './agent-setup';

const REMOTE_TIMEOUT_MS = 10 * 60 * 1000; // 10 min for remote
const LOCAL_TIMEOUT_MS = 5 * 60 * 1000;   // 5 min for local

export async function runCommand(command: string, args: string[], cwd?: string, timeoutMs?: number): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: cwd || SCRIPT_DIR,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';

        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');

        child.stdout.on('data', (chunk: string) => {
            stdout += chunk;
        });

        child.stderr.on('data', (chunk: string) => {
            stderr += chunk;
        });

        // Optional timeout — mirrors remote timeout pattern (lines 99-102)
        let timer: ReturnType<typeof setTimeout> | undefined;
        if (timeoutMs) {
            timer = setTimeout(() => {
                try { child.kill(); } catch {}
                reject(new Error(`Command timed out after ${timeoutMs / 1000}s`));
            }, timeoutMs);
        }

        child.on('error', (error) => {
            if (timer) clearTimeout(timer);
            reject(error);
        });

        child.on('close', (code) => {
            if (timer) clearTimeout(timer);
            if (code === 0) {
                resolve(stdout);
                return;
            }

            const errorMessage = stderr.trim() || `Command exited with code ${code}`;
            reject(new Error(errorMessage));
        });
    });
}

/**
 * Run a command via SSH with stdin piping for the prompt.
 * Avoids shell escaping issues by writing prompt to temp file via stdin.
 */
async function runCommandRemote(
    host: string,
    user: string,
    remoteProjectRoot: string,
    claudeArgs: string[],
    prompt: string,
): Promise<string> {
    const tmpFile = `/tmp/tinyclaw-prompt-${Date.now()}.txt`;

    // Step 1: Write prompt to temp file on remote host via stdin
    log('INFO', `Writing prompt to ${user}@${host}:${tmpFile}`);
    await new Promise<void>((resolve, reject) => {
        const writeProc = spawn('ssh', [`${user}@${host}`, `cat > ${tmpFile}`], {
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        writeProc.stdin!.write(prompt);
        writeProc.stdin!.end();
        writeProc.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`Failed to write prompt via SSH (exit ${code})`));
        });
        writeProc.on('error', reject);
    });

    // Step 2: Build remote command that reads from temp file
    const argsStr = claudeArgs.join(' ');
    const remoteCmd = [
        `cd ${remoteProjectRoot}`,
        `source /etc/trading-signal-ai.env 2>/dev/null || true`,
        `PROMPT=$(cat ${tmpFile})`,
        `rm -f ${tmpFile}`,
        `claude ${argsStr} -p "$PROMPT"`,
    ].join(' && ');

    // Step 3: Execute via SSH with timeout
    return new Promise((resolve, reject) => {
        const child = spawn('ssh', [`${user}@${host}`, remoteCmd], {
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => { stdout += chunk; });
        child.stderr.on('data', (chunk: string) => { stderr += chunk; });

        const timeout = setTimeout(() => {
            try { child.kill(); } catch {}
            reject(new Error(`Remote command timed out after ${REMOTE_TIMEOUT_MS / 1000}s`));
        }, REMOTE_TIMEOUT_MS);

        child.on('close', (code) => {
            clearTimeout(timeout);
            if (code === 0) {
                resolve(stdout.trim());
            } else {
                reject(new Error(stderr.trim() || `Remote exit code ${code}`));
            }
        });
        child.on('error', (err) => {
            clearTimeout(timeout);
            reject(err);
        });
    });
}

/**
 * Invoke a single agent with a message. Contains all Claude/Codex invocation logic.
 * Returns the raw response text.
 */
export async function invokeAgent(
    agent: AgentConfig,
    agentId: string,
    message: string,
    workspacePath: string,
    shouldReset: boolean,
    agents: Record<string, AgentConfig> = {},
    teams: Record<string, TeamConfig> = {}
): Promise<string> {
    // Ensure agent directory exists with config files
    const agentDir = path.join(workspacePath, agentId);
    const isNewAgent = !fs.existsSync(agentDir);
    ensureAgentDirectory(agentDir);
    if (isNewAgent) {
        log('INFO', `Initialized agent directory with config files: ${agentDir}`);
    }

    // Update AGENTS.md with current teammate info
    updateAgentTeammates(agentDir, agentId, agents, teams);

    // Resolve working directory
    const workingDir = agent.working_directory
        ? (path.isAbsolute(agent.working_directory)
            ? agent.working_directory
            : path.join(workspacePath, agent.working_directory))
        : agentDir;

    const provider = agent.provider || 'anthropic';

    // Remote invocation via SSH (e.g., researcher on CT110)
    if (agent.invoke_mode === 'remote') {
        const remoteHost = agent.remote_host;
        const remoteUser = agent.remote_user;
        const remoteRoot = agent.remote_project_root;

        if (!remoteHost || !remoteUser || !remoteRoot) {
            throw new Error(`Agent ${agentId} has invoke_mode=remote but missing remote_host/remote_user/remote_project_root`);
        }

        log('INFO', `Remote invocation: ${agentId} → ${remoteUser}@${remoteHost}`);

        const modelId = resolveClaudeModel(agent.model);
        const claudeArgs: string[] = ['--dangerously-skip-permissions'];
        if (modelId) {
            claudeArgs.push('--model', modelId);
        }
        if (!shouldReset) {
            claudeArgs.push('-c');
        }

        return await runCommandRemote(remoteHost, remoteUser, remoteRoot, claudeArgs, message);
    }

    if (provider === 'openai') {
        log('INFO', `Using Codex CLI (agent: ${agentId})`);

        const shouldResume = !shouldReset;

        if (shouldReset) {
            log('INFO', `🔄 Resetting Codex conversation for agent: ${agentId}`);
        }

        const modelId = resolveCodexModel(agent.model);
        const codexArgs = ['exec'];
        if (shouldResume) {
            codexArgs.push('resume', '--last');
        }
        if (modelId) {
            codexArgs.push('--model', modelId);
        }
        codexArgs.push('--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '--json', message);

        const codexOutput = await runCommand('codex', codexArgs, workingDir, LOCAL_TIMEOUT_MS);

        // Parse JSONL output and extract final agent_message
        let response = '';
        const lines = codexOutput.trim().split('\n');
        for (const line of lines) {
            try {
                const json = JSON.parse(line);
                if (json.type === 'item.completed' && json.item?.type === 'agent_message') {
                    response = json.item.text;
                }
            } catch (e) {
                // Ignore lines that aren't valid JSON
            }
        }

        return response || 'Sorry, I could not generate a response from Codex.';
    } else {
        // Default to Claude (Anthropic)
        log('INFO', `Using Claude provider (agent: ${agentId})`);

        const continueConversation = !shouldReset;

        if (shouldReset) {
            log('INFO', `🔄 Resetting conversation for agent: ${agentId}`);
        }

        const modelId = resolveClaudeModel(agent.model);
        const claudeArgs = ['--dangerously-skip-permissions'];
        if (modelId) {
            claudeArgs.push('--model', modelId);
        }
        if (continueConversation) {
            claudeArgs.push('-c');
        }
        claudeArgs.push('-p', message);

        return await runCommand('claude', claudeArgs, workingDir, LOCAL_TIMEOUT_MS);
    }
}
