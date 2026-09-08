#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { build } from "./build.js";
import { init } from "./init.js";
import { createLogger } from "./logger.js";
import { loadProduct, productRootDir } from "./product.js";

/**
 * Retrieves the product version from its package metadata.
 * @return {string} The product version, or `"0.0.0"` when the metadata cannot be read, parsed, or does not contain a string version.
 */
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

/**
 * Prints the CLI usage, commands, and options for a product.
 * @param {object} product - Product metadata containing its name, description, and executable name.
 */
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

/**
 * Executes the CLI command specified by the provided arguments.
 * @param {string[]} argv - Command-line arguments, including an optional command and project directory.
 * @throws {Error} If the command or project directory is invalid.
 */
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
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp(product);
    return;
  }
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
