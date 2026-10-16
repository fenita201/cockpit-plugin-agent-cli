// @ts-nocheck -- temporary while command handlers are extracted into the injected service.
import path from "path";

import express from "express";

import { getCommandHelp, getProjectMemory, listCommands } from '@/modules/commands/services/command-catalog.service.js';

import { parseFrontMatter } from "@/shared/index.js";

type CommandsRouterDependencies = {
  fileSystem: typeof import('node:fs/promises');
  homeDirectory(): string;
  appRoot: string;
  models: typeof import('../providers/index.js').providerModelsService;
  runtime: {
    uptime(): number;
    memoryUsage(): NodeJS.MemoryUsage;
    version: string;
    platform: NodeJS.Platform;
    pid: number;
  };
};

/** Creates Commands routes around explicit filesystem, model-catalog, and runtime adapters. */
export function createCommandsRouter(dependencies: CommandsRouterDependencies): express.Router {
const fs = dependencies.fileSystem;
const os = { homedir: dependencies.homeDirectory };
const APP_ROOT = dependencies.appRoot;
const providerModelsService = dependencies.models;
const process = dependencies.runtime;
const router = express.Router();

const MODEL_PROVIDERS = ["claude", "codex"];

const MODEL_PROVIDER_LABELS = {
  claude: "Claude",
  codex: "Codex",
};

const readModelProvider = (value) => {
  if (typeof value !== "string") {
    return "claude";
  }

  const normalized = value.trim().toLowerCase();
  return MODEL_PROVIDERS.includes(normalized) ? normalized : "claude";
};

/**
 * Resolves the model a command should report.
 *
 * `context.model` is what the composer would send right now, so it stands in
 * for a chat that has no session row yet; the service prefers the session's own
 * recorded model whenever there is one.
 */
const resolveCommandModel = async (modelsService, provider, context) => {
  const resolved = await modelsService.resolveSessionModel(provider, {
    sessionId: context?.sessionId,
    requestedModel: context?.model,
  });
  return resolved.model;
};

const executeModelsCommand = async (args, context, modelsService) => {
  const currentProvider = readModelProvider(context?.provider);
  const catalog = await modelsService.getProviderModels(currentProvider);
  const currentModel = await resolveCommandModel(modelsService, currentProvider, context);
  const availableModels = catalog.OPTIONS.map((option) => option.value);
  const availableOptions = catalog.OPTIONS.map((option) => ({
    value: option.value,
    label: option.label,
    description: option.description,
    recordId: option.recordId,
    isCustom: option.isCustom,
  }));

  return {
    type: "builtin",
    action: "models",
    data: {
      current: {
        provider: currentProvider,
        providerLabel: MODEL_PROVIDER_LABELS[currentProvider],
        model: currentModel,
      },
      available: {
        [currentProvider]: availableModels,
      },
      availableModels,
      availableOptions,
      defaultModel: catalog.DEFAULT,
      message: `Current model: ${currentModel}`,
    },
  };
};

/**
 * Built-in command handlers
 * Each handler returns { type: 'builtin', action: string, data: any }
 */
const builtInHandlers = {
  "/help": async (_args, context) => getCommandHelp(readModelProvider(context?.provider)),

  "/models": (args, context) => executeModelsCommand(args, context, providerModelsService),

  "/cost": async (args, context) => {
    const tokenUsage = context?.tokenUsage || {};
    const provider = readModelProvider(context?.provider);
    const model = await resolveCommandModel(providerModelsService, provider, context);

    const reportedUsed =
      Number(
        tokenUsage.used ?? tokenUsage.totalUsed ?? tokenUsage.total_tokens ?? 0,
      ) || 0;
    const total =
      Number(
        tokenUsage.total ??
          tokenUsage.contextWindow ??
          0,
      ) || 0;
    const normalizedInputValue =
      tokenUsage.inputTokens ??
      tokenUsage.input ??
      tokenUsage.cumulativeInputTokens ??
      tokenUsage.breakdown?.input ??
      tokenUsage.promptTokens;
    const directInputTokens =
      Number(
        normalizedInputValue ??
          tokenUsage.input_tokens ??
          0
      ) || 0;
    const cacheReadTokens =
      Number(
        tokenUsage.cacheReadTokens ??
          tokenUsage.cache_read_input_tokens ??
          tokenUsage.cacheReadInputTokens ??
          0,
      ) || 0;
    const cacheCreationTokens =
      Number(
        tokenUsage.cacheCreationTokens ??
          tokenUsage.cache_creation_input_tokens ??
          tokenUsage.cacheCreationInputTokens ??
          0,
      ) || 0;
    const inputTokens = normalizedInputValue == null
      ? directInputTokens + cacheReadTokens + cacheCreationTokens
      : directInputTokens;
    const outputTokens =
      Number(
        tokenUsage.outputTokens ??
          tokenUsage.output ??
          tokenUsage.output_tokens ??
          tokenUsage.cumulativeOutputTokens ??
          tokenUsage.breakdown?.output ??
          tokenUsage.completionTokens ??
          0,
      ) || 0;
    const computedUsed = inputTokens + outputTokens;
    const hasTokenBreakdown = computedUsed > 0;
    const used = Math.max(reportedUsed, computedUsed);

    return {
      type: "builtin",
      action: "cost",
      data: {
        tokenUsage: {
          used,
          total,
        },
        ...(hasTokenBreakdown
          ? {
              tokenBreakdown: {
                input: inputTokens,
                output: outputTokens,
              },
            }
          : {}),
        provider,
        model,
      },
    };
  },

  "/status": async (args, context) => {
    // Read version from package.json
    const packageJsonPath = path.join(APP_ROOT, "package.json");
    let version = "unknown";
    let packageName = "claude-code-ui";

    try {
      const packageJson = JSON.parse(
        await fs.readFile(packageJsonPath, "utf8"),
      );
      version = packageJson.version;
      packageName = packageJson.name;
    } catch (err) {
      console.error("Error reading package.json:", err);
    }

    const uptime = process.uptime();
    const uptimeMinutes = Math.floor(uptime / 60);
    const uptimeHours = Math.floor(uptimeMinutes / 60);
    const uptimeFormatted =
      uptimeHours > 0
        ? `${uptimeHours}h ${uptimeMinutes % 60}m`
        : `${uptimeMinutes}m`;

    const statusProvider = readModelProvider(context?.provider);
    const model = await resolveCommandModel(providerModelsService, statusProvider, context);
    const memoryUsage = process.memoryUsage();

    return {
      type: "builtin",
      action: "status",
      data: {
        version,
        packageName,
        uptime: uptimeFormatted,
        uptimeSeconds: Math.floor(uptime),
        model,
        provider: statusProvider,
        nodeVersion: process.version,
        platform: process.platform,
        pid: process.pid,
        memoryUsage: {
          rssMb: Math.round(memoryUsage.rss / 1024 / 1024),
          heapUsedMb: Math.round(memoryUsage.heapUsed / 1024 / 1024),
          heapTotalMb: Math.round(memoryUsage.heapTotal / 1024 / 1024),
        },
      },
    };
  },

  "/memory": async (_args, context) => getProjectMemory(readModelProvider(context?.provider), context?.projectPath, (file) => fs.access(file)),

  "/config": async (args, context) => {
    return {
      type: "builtin",
      action: "config",
      data: {
        message: "Opening settings...",
      },
    };
  },
};

/**
 * POST /api/commands/list
 * List all available commands from project and user directories
 */
router.post("/list", async (req, res) => {
  try {
    const { projectPath, provider } = req.body;
    res.json(await listCommands(readModelProvider(provider), typeof projectPath === 'string' ? projectPath : undefined, os.homedir(), fs));
  } catch (error) {
    console.error("Error listing commands:", error);
    res.status(500).json({
      error: "Failed to list commands",
      message: error.message,
    });
  }
});

/**
 * POST /api/commands/execute
 * Execute a command with argument replacement
 * This endpoint prepares the command content but doesn't execute bash commands yet
 * (that will be handled in the command parser utility)
 */
router.post("/execute", async (req, res) => {
  try {
    const { commandName, commandPath, args = [], context = {} } = req.body;

    if (!commandName) {
      return res.status(400).json({
        error: "Command name is required",
      });
    }

    // Handle built-in commands
    const handler = builtInHandlers[commandName];
    if (handler) {
      try {
        const result = await handler(args, context);
        return res.json({
          ...result,
          command: commandName,
        });
      } catch (error) {
        console.error(
          `Error executing built-in command ${commandName}:`,
          error,
        );
        return res.status(500).json({
          error: "Command execution failed",
          message: error.message,
          command: commandName,
        });
      }
    }

    // Handle custom commands
    if (!commandPath) {
      return res.status(400).json({
        error: "Command path is required for custom commands",
      });
    }

    // Load command content
    // Security: validate commandPath is within allowed directories
    {
      const resolvedPath = path.resolve(commandPath);
      const userBase = path.resolve(
        path.join(os.homedir(), ".claude", "commands"),
      );
      const projectBase = context?.projectPath
        ? path.resolve(path.join(context.projectPath, ".claude", "commands"))
        : null;
      const isUnder = (base) => {
        const rel = path.relative(base, resolvedPath);
        return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
      };
      if (!(isUnder(userBase) || (projectBase && isUnder(projectBase)))) {
        return res.status(403).json({
          error: "Access denied",
          message: "Command must be in .claude/commands directory",
        });
      }
    }
    const content = await fs.readFile(commandPath, "utf8");
    const { data: metadata, content: commandContent } =
      parseFrontMatter(content);
    // Basic argument replacement (will be enhanced in command parser utility)
    let processedContent = commandContent;

    // Replace $ARGUMENTS with all arguments joined
    const argsString = args.join(" ");
    processedContent = processedContent.replace(/\$ARGUMENTS/g, argsString);

    // Replace $1, $2, etc. with positional arguments
    args.forEach((arg, index) => {
      const placeholder = `$${index + 1}`;
      processedContent = processedContent.replace(
        new RegExp(`\\${placeholder}\\b`, "g"),
        arg,
      );
    });

    res.json({
      type: "custom",
      command: commandName,
      content: processedContent,
      metadata,
      hasFileIncludes: processedContent.includes("@"),
      hasBashCommands: processedContent.includes("!"),
    });
  } catch (error) {
    if (error.code === "ENOENT") {
      return res.status(404).json({
        error: "Command not found",
        message: `Command file not found: ${req.body.commandPath}`,
      });
    }

    console.error("Error executing command:", error);
    res.status(500).json({
      error: "Failed to execute command",
      message: error.message,
    });
  }
});

return router;
}
