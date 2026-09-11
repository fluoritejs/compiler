#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { build } from "./build.js";
import { init } from "./init.js";
import { createLogger } from "./logger.js";
import { loadProduct, productRootDir } from "./product.js";
import {
  login,
  logout,
  status,
  search,
  publish,
  setYanked,
} from "./registry-cli.js";

async function productVersion() {
  try {
    const packageJson = JSON.parse(
      await readFile(join(productRootDir(), "package.json"), "utf8"),
    );
    return typeof packageJson.version === "string"
      ? packageJson.version
      : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function printHelp(product) {
  const usage = `${product.bin} <command> [project-dir]`;
  const lines = [
    product.name,
    "",
    product.description,
    "",
    `Usage:`,
    `  ${usage}`,
    "",
    `Commands:`,
    `  init    Scaffold a new extension project with source, manifest, and assets.`,
    `  build   Compile an extension project into a single TurboWarp extension file.`,
    `  login   Sign in to a registry; stores the session for other commands.`,
    `  logout  Clear the stored registry session.`,
    `  status  Show the signed-in user for the default registry.`,
    `  publish Compile the project and push the result to the registry.`,
    `  search  Search the registry for extensions.`,
    `  yank    Mark a published version as yanked (hidden from listings).`,
    `  unyank  Reverse a previous yank for a version.`,
    "",
    `Flags:`,
    `  --registry <url>     Registry to use (defaults to the stored config).`,
    `  --token <token>      Authentication token; overrides the stored session.`,
    `  --namespace <name>   Publish/yank namespace (defaults to the stored user).`,
    `  --config <path>      Path to the compiler config file.`,
    `  --reason <text>      Reason attached to a yank.`,
    `  -h, --help           Show this help message.`,
    `  -V, --version        Print the version of ${product.name}.`,
    "",
    `Examples:`,
    `  ${product.bin} login alice --registry https://registry.example.com`,
    `  ${product.bin} publish .`,
    `  ${product.bin} search scratch`,
    `  ${product.bin} yank 1.0.0 --reason "Security issue"`,
  ];
  process.stdout.write(lines.join("\n") + "\n");
}

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  const valueFlags = new Set([
    "registry",
    "token",
    "namespace",
    "config",
    "reason",
  ]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (valueFlags.has(arg.replace(/^--/, "")) && arg.startsWith("--")) {
      const name = arg.replace(/^--/, "");
      const value = argv[i + 1];
      if (value === undefined) {
        throw new Error(`Missing value for ${arg}.`);
      }
      flags[name] = value;
      i++;
    } else if (arg === "--help" || arg === "-h") {
      flags.help = true;
    } else if (arg === "--version" || arg === "-V") {
      flags.version = true;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown flag "${arg}".`);
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

async function main(argv) {
  const product = await loadProduct();
  const logger = createLogger({
    color: { out: !!process.stdout.isTTY, err: !!process.stderr?.isTTY },
  });

  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    printHelp(product);
    return;
  }
  if (argv[0] === "--version" || argv[0] === "-V") {
    process.stdout.write(`${product.name} ${await productVersion()}\n`);
    return;
  }

  const { flags, positional } = parseArgs(argv);
  if (flags.help) {
    printHelp(product);
    return;
  }
  if (flags.version) {
    process.stdout.write(`${product.name} ${await productVersion()}\n`);
    return;
  }

  const [command, firstArg, secondArg] = positional;
  const commandOptions = {
    registry: flags.registry,
    token: flags.token,
    namespace: flags.namespace,
    configPath: flags.config,
  };
  const dir = firstArg || process.cwd();
  if (typeof dir === "string" && dir.startsWith("-")) {
    throw new Error(
      `Unknown project directory "${dir}". Run "${product.bin} --help" for usage.`,
    );
  }

  switch (command) {
    case "init":
      await init(dir, { logger, product });
      return;
    case "build":
      await build(dir, { logger, product });
      return;
    case "login":
      await login(firstArg, { ...commandOptions, logger, product });
      return;
    case "logout":
      await logout({ ...commandOptions, logger });
      return;
    case "status":
      await status({ ...commandOptions, logger });
      return;
    case "publish":
      await publish(dir, { ...commandOptions, logger, product });
      return;
    case "search":
      await search(firstArg, { ...commandOptions, logger });
      return;
    case "yank":
      if (!firstArg) {
        throw new Error(
          `yank requires a version: "${product.bin} yank <version> [project-dir]".`,
        );
      }
      await setYanked(firstArg, true, secondArg || process.cwd(), {
        ...commandOptions,
        reason: flags.reason,
        logger,
      });
      return;
    case "unyank":
      if (!firstArg) {
        throw new Error(
          `unyank requires a version: "${product.bin} unyank <version> [project-dir]".`,
        );
      }
      await setYanked(firstArg, false, secondArg || process.cwd(), {
        ...commandOptions,
        logger,
      });
      return;
  }

  throw new Error(
    `Unknown command "${command}". Run "${product.bin} --help" for usage.`,
  );
}

main(process.argv.slice(2)).catch((error) => {
  const logger = createLogger({
    color: { out: false, err: !!process.stderr?.isTTY },
  });
  let message;
  if (error instanceof Error) {
    message = error.message;
  } else if (typeof error === "string") {
    message = error;
  } else {
    try {
      message = JSON.stringify(error);
    } catch {
      message = String(error);
    }
  }
  logger.error(message);
  if (error instanceof Error && error.cause) {
    logger.error(
      `Caused by: ${error.cause instanceof Error ? error.cause.message : String(error.cause)}`,
    );
  }
  process.exitCode = 1;
});
