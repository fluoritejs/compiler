#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { build } from "./build.js";
import { init } from "./init.js";
import { createLogger } from "./logger.js";
import { loadProduct, productRootDir } from "./product.js";

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
    `  init   Scaffold a new extension project with source, manifest, and assets.`,
    `  build  Compile an extension project into a single TurboWarp extension file.`,
    "",
    `Options:`,
    `  -h, --help     Show this help message.`,
    `  -V, --version  Print the version of ${product.name}.`,
  ];
  process.stdout.write(lines.join("\n") + "\n");
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

  const [command, targetDir] = argv;
  if (typeof targetDir === "string" && targetDir.startsWith("-")) {
    throw new Error(
      `Unknown project directory "${targetDir}". Run "${product.bin} --help" for usage.`,
    );
  }
  const dir = targetDir || process.cwd();

  if (command === "init") {
    await init(dir, { logger, product });
    return;
  }
  if (command === "build") {
    await build(dir, { logger, product });
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
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : JSON.stringify(error);
  logger.error(message);
  if (error instanceof Error && error.cause) {
    logger.error(
      `Caused by: ${error.cause instanceof Error ? error.cause.message : String(error.cause)}`,
    );
  }
  process.exitCode = 1;
});
