import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PRODUCT_FILE = ".product.json";
const productRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const VALID_BIN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const VALID_GLOBAL = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Get the root directory containing the product metadata.
 * @return {string} The product root directory.
 */
export function productRootDir() {
  return productRoot;
}

/**
 * Loads and validates product metadata from the product configuration file.
 * @returns {object} The validated product metadata.
 * @throws {Error} If the configuration file cannot be read, contains invalid JSON, or has invalid metadata.
 */
export async function loadProduct() {
  let raw;
  try {
    raw = await readFile(join(productRoot, PRODUCT_FILE), "utf8");
  } catch (error) {
    throw new Error(
      `Cannot find ${PRODUCT_FILE} next to the product source. Run the compiler from a valid install.`,
      { cause: error },
    );
  }

  let product;
  try {
    product = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `${PRODUCT_FILE} at ${join(productRoot, PRODUCT_FILE)} is not valid JSON: ${error.message}`,
      { cause: error },
    );
  }

  if (
    typeof product !== "object" ||
    product === null ||
    typeof product.name !== "string" ||
    product.name.length === 0
  ) {
    throw new Error(`${PRODUCT_FILE} must define a non-empty "name" string.`);
  }
  if (typeof product.bin !== "string" || !VALID_BIN.test(product.bin)) {
    throw new Error(`${PRODUCT_FILE} must define a valid "bin" name.`);
  }
  if (
    typeof product.runtimeGlobal !== "string" ||
    !VALID_GLOBAL.test(product.runtimeGlobal)
  ) {
    throw new Error(
      `${PRODUCT_FILE} must define a valid "runtimeGlobal" identifier.`,
    );
  }
  if (typeof product.description !== "string") {
    throw new Error(`${PRODUCT_FILE} must define a "description" string.`);
  }

  return product;
}
