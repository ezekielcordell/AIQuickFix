import { spawn } from "child_process";
import * as path from "path";
import * as vscode from "vscode";

type FixerId = "codex" | "claude" | "codex-cli" | "claude-cli";
type CliFixerId = "codex-cli" | "claude-cli";

interface RunFixerArgs {
    fixerId?: FixerId;
    fixer?: string;
    uri: vscode.Uri;
    range: vscode.Range;
    diagnosticMessage?: string;
}

interface FixerSpec {
    id: FixerId;
    label: string;
}

interface CommandSpec {
    command: string;
    args: string[];
}

interface CliRoute {
    id: string;
    display: string;
    probe: CommandSpec;
    buildRun: (prompt: string) => CommandSpec;
}

interface CliSettings {
    enableWslRoutes: boolean;
}

interface ProcessResult {
    exitCode: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    errorCode?: string;
}

interface PromptSpec {
    prompt: string;
    line: number;
}

const OUTPUT = vscode.window.createOutputChannel("AI Quick Fix");

const CODEX_COMMAND = "chatgpt.implementTodo";
const CLAUDE_EDITOR_COMMAND = "claude-vscode.editor.open";
const CLAUDE_TERMINAL_COMMAND = "claude-vscode.terminal.open";
const CLI_ROUTE_STATE_KEY = "aiQuickFix.cliRouteByFixer.v1";
const CLI_PROBE_TIMEOUT_MS = 3000;
const CLI_RUN_TIMEOUT_MS = 180000;
const MAX_PROCESS_OUTPUT_CHARS = 12000;
const MAX_BOX_CONTENT_CHARS = 4000;
const OUTPUT_BOX_WIDTH = 100;
const MAX_FAILURE_SUMMARY_LINES = 8;

const FIXERS: Record<FixerId, FixerSpec> = {
    codex: { id: "codex", label: "Codex" },
    claude: { id: "claude", label: "Claude" },
    "codex-cli": { id: "codex-cli", label: "Codex CLI" },
    "claude-cli": { id: "claude-cli", label: "Claude CLI" },
};

let extensionContextRef: vscode.ExtensionContext | undefined;
const cliRouteCache = new Map<CliFixerId, CliRoute | null>();
const cliRouteDiscovery = new Map<CliFixerId, Promise<CliRoute | null>>();
const cliProbeCache = new Map<string, boolean>();
const cliProbeDiscovery = new Map<string, Promise<boolean>>();
const commandAvailabilityCache = new Map<string, boolean>();

export function activate(context: vscode.ExtensionContext): void {
    extensionContextRef = context;

    const provider = vscode.languages.registerCodeActionsProvider(
        { scheme: "file" },
        new AiQuickFixProvider(),
        { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
    );

    const runFixer = vscode.commands.registerCommand(
        "aiQuickFix.runFixer",
        async (args: RunFixerArgs) => {
            const fixerId = resolveFixerId(args);
            if (!args || !fixerId || !args.uri || !args.range) {
                void vscode.window.showErrorMessage(
                    "AI Quick Fix: invalid command arguments.",
                );
                return;
            }

            try {
                await runVsCodeCommandFixer(args, fixerId);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                OUTPUT.appendLine(`[error] ${msg}`);
                void vscode.window.showErrorMessage(
                    `AI Quick Fix failed: ${msg}`,
                );
            }
        },
    );

    context.subscriptions.push(provider, runFixer, OUTPUT);
    void warmCliRouteCache();
}

class AiQuickFixProvider implements vscode.CodeActionProvider {
    async provideCodeActions(
        document: vscode.TextDocument,
        range: vscode.Range,
        context: vscode.CodeActionContext,
    ): Promise<vscode.CodeAction[]> {
        const fixers = await getEnabledFixers();
        if (fixers.length === 0 || context.diagnostics.length === 0) {
            return [];
        }

        const actions: vscode.CodeAction[] = [];

        for (const diagnostic of context.diagnostics) {
            for (const fixer of fixers) {
                const action = new vscode.CodeAction(
                    `Fix With "${fixer.label}"`,
                    vscode.CodeActionKind.QuickFix,
                );
                action.isPreferred = false;
                action.diagnostics = [diagnostic];
                action.command = {
                    command: "aiQuickFix.runFixer",
                    title: `Run fixer ${fixer.label}`,
                    arguments: [
                        {
                            fixerId: fixer.id,
                            uri: document.uri,
                            range: diagnostic.range ?? range,
                            diagnosticMessage: diagnostic.message,
                        } satisfies RunFixerArgs,
                    ],
                };
                actions.push(action);
            }
        }

        return actions;
    }
}

async function getEnabledFixers(): Promise<FixerSpec[]> {
    const config = vscode.workspace.getConfiguration("ai-quick-fix");
    const codex = parseBoolean(config.get<unknown>("codex"), true);
    const claude = parseBoolean(config.get<unknown>("claude"), true);
    const codexCli = parseBoolean(config.get<unknown>("codex-cli"), false);
    const claudeCli = parseBoolean(config.get<unknown>("claude-cli"), false);
    const enabled: FixerSpec[] = [];

    if (codex) {
        enabled.push(FIXERS.codex);
    }
    if (claude) {
        enabled.push(FIXERS.claude);
    }
    if (codexCli && (await getCliRoute("codex-cli"))) {
        enabled.push(FIXERS["codex-cli"]);
    }
    if (claudeCli && (await getCliRoute("claude-cli"))) {
        enabled.push(FIXERS["claude-cli"]);
    }

    return enabled;
}

async function runVsCodeCommandFixer(
    args: RunFixerArgs,
    fixerId: FixerId,
): Promise<void> {
    const promptSpec = await buildPrompt(args);

    switch (fixerId) {
        case "codex":
            await runCodexFix(args, promptSpec);
            break;
        case "claude":
            await runClaudeFix(promptSpec.prompt);
            break;
        case "codex-cli":
            await runCliFix(args, promptSpec.prompt, "codex-cli");
            break;
        case "claude-cli":
            await runCliFix(args, promptSpec.prompt, "claude-cli");
            break;
    }
}

async function runCodexFix(
    args: RunFixerArgs,
    promptSpec: PromptSpec,
): Promise<void> {
    await assertCommandAvailable(
        CODEX_COMMAND,
        "Codex quick fix requires the OpenAI ChatGPT VS Code extension.",
    );
    await vscode.commands.executeCommand(CODEX_COMMAND, {
        fileName: encodeURIComponent(args.uri.fsPath),
        line: promptSpec.line,
        comment: promptSpec.prompt,
    });
    OUTPUT.appendLine(
        `[codex] Sent minimal prompt to line ${promptSpec.line}.`,
    );
}

async function runClaudeFix(prompt: string): Promise<void> {
    const editorAvailable = await isCommandAvailable(CLAUDE_EDITOR_COMMAND);
    const terminalAvailable = await isCommandAvailable(CLAUDE_TERMINAL_COMMAND);

    if (!editorAvailable && !terminalAvailable) {
        throw new Error(
            "Claude quick fix requires the Claude Code VS Code extension.",
        );
    }

    const failures: string[] = [];
    if (editorAvailable) {
        const sessionId = makeClaudeSessionId();
        try {
            await vscode.commands.executeCommand(
                CLAUDE_EDITOR_COMMAND,
                sessionId,
                prompt,
            );
            OUTPUT.appendLine(
                "[claude] Opened Claude chat and submitted prompt.",
            );
            return;
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);
            failures.push(`editor flow failed: ${message}`);
        }
    }

    if (terminalAvailable) {
        try {
            await vscode.commands.executeCommand(
                CLAUDE_TERMINAL_COMMAND,
                prompt,
                ["-p"],
                "beside",
            );
            OUTPUT.appendLine(
                "[claude] Submitted prompt through Claude terminal fallback.",
            );
            return;
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);
            failures.push(`terminal fallback failed: ${message}`);
        }
    }

    throw new Error(
        `Claude quick fix failed. ${failures.join(" | ") || "No executable route was available."}`,
    );
}

async function runCliFix(
    args: RunFixerArgs,
    prompt: string,
    fixerId: CliFixerId,
): Promise<void> {
    const baseRoute = await getCliRoute(fixerId);
    if (!baseRoute) {
        throw new Error(
            `${FIXERS[fixerId].label} is enabled, but no working CLI route was found.`,
        );
    }

    const cwd = getCommandWorkingDirectory(args.uri);
    const cliPrompt = buildCliPrompt(args.uri, prompt);
    const routes = orderRoutesWithPreferred(
        getCliRouteCandidates(fixerId),
        baseRoute.id,
    );
    const failures: string[] = [];
    let sawInvocationFailureOnly = true;

    for (const route of routes) {
        if (route.id !== baseRoute.id) {
            const probeOk = await probeRoute(route, cwd);
            if (!probeOk) {
                continue;
            }
        }

        const result = await runCommand(
            route.buildRun(cliPrompt),
            cwd,
            CLI_RUN_TIMEOUT_MS,
        );
        if (isReadOnlySandboxNotice(result)) {
            sawInvocationFailureOnly = false;
            failures.push(
                `${route.display}: reported read-only sandbox, so no file edits were saved.`,
            );
            continue;
        }

        if (isProcessSuccess(result)) {
            await setCachedCliRoute(fixerId, route);
            appendOutputBox(`${FIXERS[fixerId].label} Quick Fix`, [
                { heading: "Route", content: route.display },
                { heading: "Prompt", content: cliPrompt },
                {
                    heading: "CLI Output",
                    content:
                        getProcessOutputText(result) ||
                        "(command returned no output)",
                },
            ]);
            return;
        }

        failures.push(`${route.display}: ${formatProcessFailure(result)}`);
        if (!isInvocationFailure(result)) {
            sawInvocationFailureOnly = false;
            break;
        }
    }

    if (sawInvocationFailureOnly) {
        await setCachedCliRoute(fixerId, null);
    }

    const summary =
        failures.length > 0
            ? failures[0]
            : "no executable command route was accepted.";
    appendOutputBox(`${FIXERS[fixerId].label} Quick Fix Failed`, [
        { heading: "Prompt", content: cliPrompt },
        {
            heading: "Route Failures",
            content: summarizeFailures(failures),
        },
    ]);
    throw new Error(`${FIXERS[fixerId].label} failed: ${summary}`);
}

async function buildPrompt(args: RunFixerArgs): Promise<PromptSpec> {
    const document = await vscode.workspace.openTextDocument(args.uri);
    const line = clampLineNumber(document, args.range.start.line) + 1;
    const locationLine = document.lineAt(line - 1).text || "(empty line)";
    const diagnostic = args.diagnosticMessage?.trim() || "(none provided)";
    return {
        line,
        prompt: `Diagnostic: ${diagnostic}\nLine: ${line}\nCode: ${locationLine}`,
    };
}

function clampLineNumber(
    document: vscode.TextDocument,
    requestedLine: number,
): number {
    if (document.lineCount <= 0) {
        return 0;
    }
    if (requestedLine < 0) {
        return 0;
    }
    return Math.min(requestedLine, document.lineCount - 1);
}

function makeClaudeSessionId(): string {
    const timestamp = Date.now();
    const nonce = Math.floor(Math.random() * 1_000_000)
        .toString()
        .padStart(6, "0");
    return `ai-quick-fix-${timestamp}-${nonce}`;
}

async function isCommandAvailable(command: string): Promise<boolean> {
    if (commandAvailabilityCache.has(command)) {
        return true;
    }

    const available = (await vscode.commands.getCommands(true)).includes(
        command,
    );
    if (available) {
        commandAvailabilityCache.set(command, true);
    }
    return available;
}

async function assertCommandAvailable(
    command: string,
    missingMessage: string,
): Promise<void> {
    if (await isCommandAvailable(command)) {
        return;
    }

    throw new Error(`${missingMessage} Missing command: ${command}`);
}

function buildCliPrompt(uri: vscode.Uri, basePrompt: string): string {
    const filePath = vscode.workspace.asRelativePath(uri, false) || uri.fsPath;
    return `File: ${filePath}\n${basePrompt}\nApply the minimal quick fix by editing workspace files directly. Save changes, then return a one-line summary.`;
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
    return typeof value === "boolean" ? value : fallback;
}

function getCliSettings(): CliSettings {
    const config = vscode.workspace.getConfiguration("ai-quick-fix");
    return {
        enableWslRoutes: parseBoolean(
            config.get<unknown>("enable-wsl-routes"),
            true,
        ),
    };
}

function getDiscoveryPreferredRouteId(
    fixerId: CliFixerId,
    routeId: string | undefined,
): string | undefined {
    if (!routeId) {
        return undefined;
    }

    if (fixerId !== "codex-cli") {
        return routeId;
    }

    if (routeId.includes(":workspace-write")) {
        return routeId;
    }

    return undefined;
}

function resolveFixerId(args: RunFixerArgs | undefined): FixerId | undefined {
    if (!args) {
        return undefined;
    }

    if (isFixerId(args.fixerId)) {
        return args.fixerId;
    }

    if (typeof args.fixer === "string") {
        switch (args.fixer.trim().toLowerCase()) {
            case "codex":
                return "codex";
            case "claude":
                return "claude";
            case "codex cli":
                return "codex-cli";
            case "claude cli":
                return "claude-cli";
        }
    }

    return undefined;
}

function isFixerId(value: unknown): value is FixerId {
    return (
        value === "codex" ||
        value === "claude" ||
        value === "codex-cli" ||
        value === "claude-cli"
    );
}

async function warmCliRouteCache(): Promise<void> {
    const config = vscode.workspace.getConfiguration("ai-quick-fix");
    const codexCli = parseBoolean(config.get<unknown>("codex-cli"), false);
    const claudeCli = parseBoolean(config.get<unknown>("claude-cli"), false);

    const tasks: Promise<CliRoute | null>[] = [];
    if (codexCli) {
        tasks.push(getCliRoute("codex-cli"));
    }
    if (claudeCli) {
        tasks.push(getCliRoute("claude-cli"));
    }

    if (tasks.length > 0) {
        await Promise.allSettled(tasks);
    }
}

async function getCliRoute(
    fixerId: CliFixerId,
    forceRefresh = false,
): Promise<CliRoute | null> {
    if (!forceRefresh && cliRouteCache.has(fixerId)) {
        const cached = cliRouteCache.get(fixerId) ?? null;
        if (!cached) {
            return null;
        }
        if (isRouteAvailable(fixerId, cached.id)) {
            return cached;
        }
        await setCachedCliRoute(fixerId, null);
    }

    if (!forceRefresh) {
        const inFlight = cliRouteDiscovery.get(fixerId);
        if (inFlight) {
            return inFlight;
        }
    }

    const discovery = discoverCliRoute(fixerId);
    cliRouteDiscovery.set(fixerId, discovery);

    try {
        return await discovery;
    } finally {
        cliRouteDiscovery.delete(fixerId);
    }
}

async function discoverCliRoute(fixerId: CliFixerId): Promise<CliRoute | null> {
    const preferred = getDiscoveryPreferredRouteId(
        fixerId,
        getPersistedRouteId(fixerId),
    );
    const routes = orderRoutesWithPreferred(
        getCliRouteCandidates(fixerId),
        preferred,
    );
    const cwd = getProbeWorkingDirectory();

    for (const route of routes) {
        if (await probeRoute(route, cwd)) {
            await setCachedCliRoute(fixerId, route);
            return route;
        }
    }

    await setCachedCliRoute(fixerId, null);
    return null;
}

function getCliRouteCandidates(fixerId: CliFixerId): CliRoute[] {
    const settings = getCliSettings();
    const routes =
        fixerId === "codex-cli" ? getCodexCliRoutes() : getClaudeCliRoutes();

    if (!settings.enableWslRoutes) {
        return routes.filter((route) => !route.id.startsWith("wsl"));
    }

    return routes;
}

function isRouteAvailable(fixerId: CliFixerId, routeId: string): boolean {
    return getCliRouteCandidates(fixerId).some((route) => route.id === routeId);
}

function getCodexCliRoutes(): CliRoute[] {
    const binaries = ["codex", "codex-cli"];
    const routes: CliRoute[] = [];

    for (const binary of binaries) {
        const variants = [
            {
                idSuffix: "workspace-write-skipgit",
                displaySuffix:
                    " (--sandbox workspace-write --skip-git-repo-check)",
                runArgs: (prompt: string) => [
                    "exec",
                    "--sandbox",
                    "workspace-write",
                    "--skip-git-repo-check",
                    prompt,
                ],
                runShell: (prompt: string) =>
                    `${binary} exec --sandbox workspace-write --skip-git-repo-check ${quoteForPosixShell(prompt)}`,
            },
            {
                idSuffix: "auto-skipgit",
                displaySuffix: " (--full-auto --skip-git-repo-check)",
                runArgs: (prompt: string) => [
                    "exec",
                    "--full-auto",
                    "--skip-git-repo-check",
                    prompt,
                ],
                runShell: (prompt: string) =>
                    `${binary} exec --full-auto --skip-git-repo-check ${quoteForPosixShell(prompt)}`,
            },
            {
                idSuffix: "skipgit",
                displaySuffix: " (--skip-git-repo-check)",
                runArgs: (prompt: string) => [
                    "exec",
                    "--skip-git-repo-check",
                    prompt,
                ],
                runShell: (prompt: string) =>
                    `${binary} exec --skip-git-repo-check ${quoteForPosixShell(prompt)}`,
            },
            {
                idSuffix: "plain",
                displaySuffix: "",
                runArgs: (prompt: string) => ["exec", prompt],
                runShell: (prompt: string) =>
                    `${binary} exec ${quoteForPosixShell(prompt)}`,
            },
        ];

        for (const variant of variants) {
            routes.push(
                {
                    id: `native:${binary}:exec:${variant.idSuffix}`,
                    display: `${binary} exec${variant.displaySuffix}`,
                    probe: { command: binary, args: ["exec", "--help"] },
                    buildRun: (prompt) => ({
                        command: binary,
                        args: variant.runArgs(prompt),
                    }),
                },
                {
                    id: `bash:${binary}:exec:${variant.idSuffix}`,
                    display: `bash -> ${binary} exec${variant.displaySuffix}`,
                    probe: {
                        command: "bash",
                        args: ["-lc", `${binary} exec --help`],
                    },
                    buildRun: (prompt) => ({
                        command: "bash",
                        args: ["-lc", variant.runShell(prompt)],
                    }),
                },
                {
                    id: `wsl:${binary}:exec:${variant.idSuffix}`,
                    display: `wsl bash -> ${binary} exec${variant.displaySuffix}`,
                    probe: {
                        command: "wsl",
                        args: ["bash", "-lc", `${binary} exec --help`],
                    },
                    buildRun: (prompt) => ({
                        command: "wsl",
                        args: ["bash", "-lc", variant.runShell(prompt)],
                    }),
                },
                {
                    id: `wsl-exec:${binary}:exec:${variant.idSuffix}`,
                    display: `wsl --exec ${binary} exec${variant.displaySuffix}`,
                    probe: {
                        command: "wsl",
                        args: ["--exec", binary, "exec", "--help"],
                    },
                    buildRun: (prompt) => ({
                        command: "wsl",
                        args: ["--exec", binary, ...variant.runArgs(prompt)],
                    }),
                },
            );
        }
    }

    return routes;
}

function getClaudeCliRoutes(): CliRoute[] {
    const binaries = ["claude", "claude-cli"];
    const routes: CliRoute[] = [];

    for (const binary of binaries) {
        routes.push(
            {
                id: `native:${binary}:p`,
                display: `${binary} -p`,
                probe: { command: binary, args: ["--help"] },
                buildRun: (prompt) => ({
                    command: binary,
                    args: ["-p", prompt],
                }),
            },
            {
                id: `native:${binary}:print`,
                display: `${binary} --print`,
                probe: { command: binary, args: ["--help"] },
                buildRun: (prompt) => ({
                    command: binary,
                    args: ["--print", prompt],
                }),
            },
            {
                id: `bash:${binary}:p`,
                display: `bash -> ${binary} -p`,
                probe: { command: "bash", args: ["-lc", `${binary} --help`] },
                buildRun: (prompt) => ({
                    command: "bash",
                    args: ["-lc", `${binary} -p ${quoteForPosixShell(prompt)}`],
                }),
            },
            {
                id: `wsl:${binary}:p`,
                display: `wsl bash -> ${binary} -p`,
                probe: {
                    command: "wsl",
                    args: ["bash", "-lc", `${binary} --help`],
                },
                buildRun: (prompt) => ({
                    command: "wsl",
                    args: [
                        "bash",
                        "-lc",
                        `${binary} -p ${quoteForPosixShell(prompt)}`,
                    ],
                }),
            },
            {
                id: `wsl-exec:${binary}:p`,
                display: `wsl --exec ${binary} -p`,
                probe: {
                    command: "wsl",
                    args: ["--exec", binary, "--help"],
                },
                buildRun: (prompt) => ({
                    command: "wsl",
                    args: ["--exec", binary, "-p", prompt],
                }),
            },
        );
    }

    return routes;
}

async function probeRoute(route: CliRoute, cwd: string): Promise<boolean> {
    const key = `${cwd}\u0000${route.probe.command}\u0000${route.probe.args.join("\u0000")}`;
    if (cliProbeCache.has(key)) {
        return cliProbeCache.get(key) ?? false;
    }

    const inFlight = cliProbeDiscovery.get(key);
    if (inFlight) {
        return inFlight;
    }

    const discovery = (async (): Promise<boolean> => {
        try {
            const result = await runCommand(
                route.probe,
                cwd,
                CLI_PROBE_TIMEOUT_MS,
            );
            const success = isProcessSuccess(result);
            cliProbeCache.set(key, success);
            return success;
        } finally {
            cliProbeDiscovery.delete(key);
        }
    })();
    cliProbeDiscovery.set(key, discovery);
    return discovery;
}

function orderRoutesWithPreferred(
    routes: CliRoute[],
    preferredId: string | undefined,
): CliRoute[] {
    if (!preferredId) {
        return routes;
    }

    const preferred = routes.find((route) => route.id === preferredId);
    if (!preferred) {
        return routes;
    }

    return [preferred, ...routes.filter((route) => route.id !== preferredId)];
}

function getPersistedRouteId(fixerId: CliFixerId): string | undefined {
    if (!extensionContextRef) {
        return undefined;
    }

    const persisted = extensionContextRef.globalState.get<
        Record<string, unknown>
    >(CLI_ROUTE_STATE_KEY, {});
    const value = persisted[fixerId];
    return typeof value === "string" ? value : undefined;
}

async function setCachedCliRoute(
    fixerId: CliFixerId,
    route: CliRoute | null,
): Promise<void> {
    cliRouteCache.set(fixerId, route);

    if (!extensionContextRef) {
        return;
    }

    const persisted = extensionContextRef.globalState.get<
        Record<string, unknown>
    >(CLI_ROUTE_STATE_KEY, {});

    if (route) {
        persisted[fixerId] = route.id;
    } else {
        delete persisted[fixerId];
    }

    await extensionContextRef.globalState.update(
        CLI_ROUTE_STATE_KEY,
        persisted,
    );
}

function getProbeWorkingDirectory(): string {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (workspaceFolder) {
        return workspaceFolder.uri.fsPath;
    }
    return process.cwd();
}

function getCommandWorkingDirectory(uri: vscode.Uri): string {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
    if (workspaceFolder) {
        return workspaceFolder.uri.fsPath;
    }
    return path.dirname(uri.fsPath);
}

function quoteForPosixShell(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function runCommand(
    spec: CommandSpec,
    cwd: string,
    timeoutMs: number,
): Promise<ProcessResult> {
    return await new Promise<ProcessResult>((resolve) => {
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        let errorCode: string | undefined;
        let settled = false;

        const finalize = (result: ProcessResult): void => {
            if (settled) {
                return;
            }
            settled = true;
            resolve(result);
        };

        let child;
        try {
            child = spawn(spec.command, spec.args, {
                cwd,
                windowsHide: true,
            });
        } catch (error) {
            const err = error as NodeJS.ErrnoException;
            finalize({
                exitCode: null,
                stdout,
                stderr: err.message,
                timedOut: false,
                errorCode: err.code,
            });
            return;
        }

        const timer = setTimeout(() => {
            timedOut = true;
            child.kill();
        }, timeoutMs);

        child.stdout.on("data", (chunk: Buffer | string) => {
            stdout = appendOutput(stdout, chunk.toString());
        });
        child.stderr.on("data", (chunk: Buffer | string) => {
            stderr = appendOutput(stderr, chunk.toString());
        });
        child.on("error", (error: NodeJS.ErrnoException) => {
            errorCode = error.code;
            clearTimeout(timer);
            finalize({
                exitCode: null,
                stdout,
                stderr: appendOutput(stderr, error.message),
                timedOut: false,
                errorCode,
            });
        });
        child.on("close", (exitCode: number | null) => {
            clearTimeout(timer);
            finalize({
                exitCode,
                stdout,
                stderr,
                timedOut,
                errorCode,
            });
        });
    });
}

function appendOutput(current: string, chunk: string): string {
    if (current.length >= MAX_PROCESS_OUTPUT_CHARS) {
        return current;
    }
    const remaining = MAX_PROCESS_OUTPUT_CHARS - current.length;
    return current + chunk.slice(0, remaining);
}

function isProcessSuccess(result: ProcessResult): boolean {
    return !result.timedOut && !result.errorCode && result.exitCode === 0;
}

function isInvocationFailure(result: ProcessResult): boolean {
    if (result.errorCode === "ENOENT") {
        return true;
    }
    if (result.exitCode === 127) {
        return true;
    }

    const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
    return (
        output.includes("not found") ||
        output.includes("command not found") ||
        output.includes("unknown option") ||
        output.includes("unexpected argument") ||
        output.includes("unrecognized option") ||
        output.includes("invalid option") ||
        output.includes("unknown command") ||
        output.includes("no such file or directory") ||
        output.includes("is not recognized as an internal or external command")
    );
}

function formatProcessFailure(result: ProcessResult): string {
    if (result.timedOut) {
        return `timed out after ${Math.round(CLI_RUN_TIMEOUT_MS / 1000)}s`;
    }
    if (result.errorCode) {
        return `spawn failed (${result.errorCode})`;
    }
    if (typeof result.exitCode === "number") {
        const output = (result.stderr || result.stdout).trim();
        if (!output) {
            return `exited with code ${result.exitCode}`;
        }
        const firstLine = output.split(/\r?\n/, 1)[0];
        return `exited with code ${result.exitCode}: ${firstLine}`;
    }
    return "unknown process failure";
}

function isReadOnlySandboxNotice(result: ProcessResult): boolean {
    const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
    return (
        output.includes("read-only sandbox") ||
        output.includes("couldn't save due read-only sandbox permissions") ||
        output.includes("could not save due read-only sandbox permissions")
    );
}

function getProcessOutputText(result: ProcessResult): string {
    const parts: string[] = [];
    const stdout = result.stdout.trim();
    const stderr = result.stderr.trim();

    if (stdout) {
        parts.push(`stdout:\n${stdout}`);
    }
    if (stderr) {
        parts.push(`stderr:\n${stderr}`);
    }

    return truncateForBox(parts.join("\n\n"), MAX_BOX_CONTENT_CHARS);
}

function summarizeFailures(failures: string[]): string {
    if (failures.length === 0) {
        return "No route failures were captured.";
    }

    const visible = failures.slice(0, MAX_FAILURE_SUMMARY_LINES).join("\n");
    const hiddenCount = failures.length - MAX_FAILURE_SUMMARY_LINES;
    if (hiddenCount <= 0) {
        return visible;
    }

    return `${visible}\n... ${hiddenCount} more route failure(s) omitted.`;
}

function appendOutputBox(
    title: string,
    sections: Array<{ heading: string; content: string }>,
): void {
    const border = `+${"-".repeat(OUTPUT_BOX_WIDTH - 2)}+`;
    OUTPUT.appendLine(border);
    for (const line of wrapBoxContent(title, OUTPUT_BOX_WIDTH - 4)) {
        OUTPUT.appendLine(formatBoxLine(` ${line}`));
    }
    OUTPUT.appendLine(border);

    for (const section of sections) {
        OUTPUT.appendLine(formatBoxLine(` ${section.heading}:`));
        const body = section.content.trim() || "(empty)";
        for (const bodyLine of body.split(/\r?\n/)) {
            for (const wrapped of wrapBoxContent(
                bodyLine.replace(/\t/g, "    "),
                OUTPUT_BOX_WIDTH - 6,
            )) {
                OUTPUT.appendLine(formatBoxLine(`   ${wrapped}`));
            }
        }
        OUTPUT.appendLine(formatBoxLine(""));
    }

    OUTPUT.appendLine(border);
}

function formatBoxLine(content: string): string {
    const innerWidth = OUTPUT_BOX_WIDTH - 2;
    const trimmed =
        content.length > innerWidth ? content.slice(0, innerWidth) : content;
    return `|${trimmed.padEnd(innerWidth, " ")}|`;
}

function wrapBoxContent(content: string, maxWidth: number): string[] {
    if (maxWidth <= 0) {
        return [""];
    }
    if (content.length === 0) {
        return [""];
    }

    const wrapped: string[] = [];
    for (let index = 0; index < content.length; index += maxWidth) {
        wrapped.push(content.slice(index, index + maxWidth));
    }
    return wrapped;
}

function truncateForBox(content: string, maxChars: number): string {
    if (content.length <= maxChars) {
        return content;
    }

    const remaining = content.length - maxChars;
    return `${content.slice(0, maxChars)}\n... [truncated ${remaining} chars]`;
}

export function deactivate(): void {
    extensionContextRef = undefined;
    cliProbeCache.clear();
    cliProbeDiscovery.clear();
    cliRouteCache.clear();
    cliRouteDiscovery.clear();
    commandAvailabilityCache.clear();
    OUTPUT.dispose();
}
