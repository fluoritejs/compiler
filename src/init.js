import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createLogger } from "./logger.js";
import { loadProduct } from "./product.js";

export const SCAFFOLD_FILES = [
  "99-manifest.json",
  "00-index.js",
  "01-hello-world.js",
  "hello-icon.svg",
];

export const MANIFEST_TEMPLATE = `${JSON.stringify(
  {
    class: "HelloWorld",
    name: "It works!",
    id: "helloworld",
    license: "LGPL-2.1",
    authors: [
      { name: "Author 1", url: "https://example.com" },
      { name: "Author 2" },
      { name: "Author 3", url: "https://example.com" },
    ],
    originalAuthors: [
      { name: "Original Author 1", url: "https://example.com" },
      { name: "Original Author 2" },
    ],
    description: "A description of the extension.",
    version: "0.1.0",
  },
  null,
  2,
)}\n`;

export const ICON_TEMPLATE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">
  <circle cx="12" cy="12" r="10" fill="#4C97FF" />
</svg>
`;

/**
 * Generates the extension entry-module source for the specified runtime global.
 * @param {string} runtimeGlobal - The global object used to access extension metadata and assets.
 * @return {string} The generated entry-module source.
 */
export function entryTemplate(runtimeGlobal) {
  return `import { hello } from "./01-hello-world.js";

export function getInfo() {
  return {
    id: ${runtimeGlobal}.meta.id,
    name: ${runtimeGlobal}.meta.name,
    blockIconURI: ${runtimeGlobal}.assets["hello-icon.svg"],
    blocks: [
      {
        opcode: "hello",
        blockType: Scratch.BlockType.REPORTER,
        text: "Hello!",
      },
    ],
  };
}
`;
}

/**
 * Generates source code for the scaffolded hello-world module.
 * @return {string} The module source containing `hello` and `unusedFunction` exports.
 */
export function helloWorldTemplate() {
  return `export function hello() {
  return "World!";
}

export function unusedFunction() {
  return "This function is unused and should be removed by the compiler.";
}
`;
}

/**
 * Creates missing scaffold files in the target directory.
 * @param {string} targetDir - The directory where scaffold files are created.
 * @param {object} product - Product metadata used to generate the entry module.
 * @param {string} product.runtimeGlobal - Runtime global referenced by the generated entry module.
 * @returns {Promise<{created: string[], skipped: string[]}>} The created and skipped file paths.
 * @throws {Error} Propagates filesystem errors other than existing-file errors.
 */
export async function scaffoldFiles(targetDir, { product, logger }) {
  const files = new Map([
    [join("src", "99-manifest.json"), MANIFEST_TEMPLATE],
    [join("src", "00-index.js"), entryTemplate(product.runtimeGlobal)],
    [join("src", "01-hello-world.js"), helloWorldTemplate()],
    [join("assets", "hello-icon.svg"), ICON_TEMPLATE],
  ]);

  const created = [];
  const skipped = [];

  for (const [relative, content] of files) {
    const file = join(targetDir, relative);
    await mkdir(dirname(file), { recursive: true });
    try {
      await writeFile(file, content, { flag: "wx" });
      created.push(file);
      logger.success(`Created ${file}`);
    } catch (error) {
      if (error?.code === "EEXIST") {
        skipped.push(file);
        logger.skip(`Skipped ${file} (already exists)`);
        continue;
      }
      throw error;
    }
  }

  return { created, skipped };
}

/**
 * Initializes a project by creating its scaffold files.
 * @param {string} [targetDir=process.cwd()] - The directory in which to create the project files.
 * @param {Object} [options] - Initialization options.
 * @param {Object} [options.logger] - Logger used during scaffolding.
 * @param {Object} [options.product] - Product metadata used to generate the scaffold.
 * @return {Promise<{created: string[], skipped: string[]}>} The created and skipped file paths.
 */
export async function init(targetDir = process.cwd(), options = {}) {
  const logger = options.logger ?? createLogger();
  const product = options.product ?? (await loadProduct());
  return scaffoldFiles(targetDir, { product, logger });
}
