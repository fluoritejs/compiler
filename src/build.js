import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import * as acorn from "acorn";
import prettier from "prettier";
import { createLogger } from "./logger.js";
import { loadProduct } from "./product.js";

const ENTRY_FILE = "00-index.js";
const MANIFEST_FILE = "99-manifest.json";
const SRC_DIR = "src";
const ASSETS_DIR = "assets";
const DIST_DIR = "dist";

const EXTENSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const JS_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const MIME_TYPES = new Map([
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".ico", "image/x-icon"],
  [".bmp", "image/bmp"],
  [".txt", "text/plain"],
  [".json", "application/json"],
  [".csv", "text/csv"],
  [".md", "text/markdown"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".ttf", "font/ttf"],
  [".otf", "font/otf"],
  [".mp3", "audio/mpeg"],
  [".wav", "audio/wav"],
  [".ogg", "audio/ogg"],
  [".flac", "audio/flac"],
  [".js", "text/javascript"],
  [".css", "text/css"],
  [".html", "text/html"],
  [".zip", "application/zip"],
  [".wasm", "application/wasm"],
]);

/**
 * Parse JavaScript source as an ECMAScript module.
 * @param {string} source - The JavaScript source to parse.
 * @param {string} file - The file path used in parse error messages.
 * @return {object} The parsed abstract syntax tree.
 */
function parse(source, file) {
  try {
    return acorn.parse(source, {
      ecmaVersion: "latest",
      sourceType: "module",
      ranges: true,
    });
  } catch (error) {
    throw new Error(`Failed to parse ${file}: ${error.message}`, {
      cause: error,
    });
  }
}

/**
 * Traverse an AST node and its child nodes.
 * @param {Object|Array} node - The AST node or collection of nodes to traverse.
 * @param {Function} visit - Callback invoked for each AST node.
 */
function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (typeof node.type !== "string") return;
  visit(node);
  for (const key of Object.keys(node)) {
    if (
      key === "start" ||
      key === "end" ||
      key === "loc" ||
      key === "range" ||
      key === "type"
    )
      continue;
    walk(node[key], visit);
  }
}

/**
 * Collect referenced identifiers and extension block function names from an AST node.
 * @param {Object} rootNode - The AST node to analyze.
 * @returns {{uses: Set<string>, opcodes: Set<string>}} The referenced identifiers and discovered block function names.
 */
function analyzeNode(rootNode, runtimeGlobal) {
  const uses = new Set();
  const opcodes = new Set();

  function isUse(parent, key) {
    if (!parent) return true;
    switch (parent.type) {
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "ArrowFunctionExpression":
        return key !== "id" && key !== "params";
      case "ClassDeclaration":
      case "ClassExpression":
        return key !== "id";
      case "VariableDeclarator":
        return key !== "id";
      case "MemberExpression":
        return key === "object" || parent.computed;
      case "Property":
        return parent.computed
          ? key === "key" || key === "value"
          : key === "value";
      case "ImportSpecifier":
      case "ImportDefaultSpecifier":
      case "ImportNamespaceSpecifier":
        return false;
      case "ExportSpecifier":
        return key === "local";
      case "LabeledStatement":
      case "BreakStatement":
      case "ContinueStatement":
        return key !== "label";
      case "MethodDefinition":
        return parent.computed ? key === "key" : false;
      default:
        return true;
    }
  }

  function visit(node, parent, key) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child, parent, key);
      return;
    }
    if (typeof node.type !== "string") return;

    if (node.type === "Identifier" && isUse(parent, key)) {
      uses.add(node.name);
    }

    if (node.type === "ObjectExpression") {
      for (const prop of node.properties) {
        if (
          prop.type === "Property" &&
          prop.key.type === "Identifier" &&
          prop.key.name === "blocks" &&
          prop.value.type === "ArrayExpression"
        ) {
          for (const block of prop.value.elements) {
            if (!block || block.type !== "ObjectExpression") continue;
            for (const blockProp of block.properties) {
              if (blockProp.type !== "Property") continue;
              if (
                blockProp.key.type === "Identifier" &&
                blockProp.key.name === "opcode"
              ) {
                if (
                  blockProp.value.type === "Literal" &&
                  typeof blockProp.value.value === "string"
                ) {
                  opcodes.add(blockProp.value.value);
                }
              }
              if (
                blockProp.key.type === "Identifier" &&
                blockProp.key.name === "function"
              ) {
                if (
                  blockProp.value.type === "Literal" &&
                  typeof blockProp.value.value === "string"
                ) {
                  opcodes.add(blockProp.value.value);
                } else if (blockProp.value.type === "Identifier") {
                  opcodes.add(blockProp.value.name);
                }
              }
            }
          }
        }
      }
    }

    for (const childKey of Object.keys(node)) {
      if (
        childKey === "start" ||
        childKey === "end" ||
        childKey === "loc" ||
        childKey === "range" ||
        childKey === "type"
      ) {
        continue;
      }
      const child = node[childKey];
      if (child && typeof child === "object") visit(child, node, childKey);
    }
  }

  visit(rootNode, null, null);
  return { uses, opcodes };
}

/**
 * Bundles the entry module and its supported local JavaScript dependencies.
 * @param {string} projectDir - The project directory containing the source files.
 * @returns {Promise<Array<object>>} Modules in dependency order, including their paths, source text, and parsed ASTs.
 * @throws {Error} If the entry file is missing, a module cannot be read or parsed, imports are unsupported, or a circular dependency is detected.
 */
async function bundleModules(projectDir) {
  const srcDir = join(projectDir, SRC_DIR);
  const entryPath = join(srcDir, ENTRY_FILE);

  let entrySource;
  try {
    entrySource = await readFile(entryPath, "utf8");
  } catch {
    throw new Error(
      `Missing entry file ${entryPath}. A ${ENTRY_FILE} file is required.`,
    );
  }

  const modules = [];
  const seen = new Set();
  const stack = [];

  function isLocalRelative(specifier) {
    return specifier.startsWith("./") || specifier.startsWith("../");
  }

  function importError(specifier, path) {
    throw new Error(
      `Unsupported import "${specifier}" in ${path}. Only local relative .js imports are supported.`,
    );
  }

  async function add(path, isEntry) {
    if (stack.includes(path)) {
      throw new Error(`Circular import detected involving ${path}.`);
    }
    if (seen.has(path)) return;
    seen.add(path);
    stack.push(path);

    const source = isEntry
      ? entrySource
      : await readFile(path, "utf8").catch((error) => {
          throw new Error(`Cannot read module ${path}: ${error.message}`);
        });

    const mod = { path, isEntry, ast: parse(source, path), source };

    for (const node of mod.ast.body) {
      if (
        node.type !== "ImportDeclaration" &&
        node.type !== "ExportNamedDeclaration" &&
        node.type !== "ExportAllDeclaration"
      ) {
        continue;
      }
      if (node.type === "ImportDeclaration") {
        for (const specifier of node.specifiers) {
          if (specifier.type !== "ImportSpecifier") {
            throw new Error(
              `Unsupported ${specifier.type} in ${path}. Only named imports without aliases are supported.`,
            );
          }
          if (specifier.imported.name !== specifier.local.name) {
            throw new Error(
              `Unsupported aliased import "${specifier.imported.name} as ${specifier.local.name}" in ${path}. Imported bindings must use their original exported names.`,
            );
          }
        }
      }
      if (!node.source) continue;
      const specifierPath = node.source.value;
      if (!isLocalRelative(specifierPath)) {
        importError(specifierPath, path);
      }
      const resolvedPath = resolve(dirname(path), specifierPath);
      if (extname(resolvedPath) !== ".js") {
        importError(specifierPath, path);
      }
      await add(resolvedPath, false);
    }

    modules.push(mod);
    stack.pop();
  }

  await add(entryPath, true);
  return modules;
}

/**
 * Loads and validates the project's extension manifest.
 * @param {string} projectDir - The project root directory containing the manifest.
 * @return {Promise<Object>} The parsed and validated manifest.
 * @throws {Error} If the manifest is missing, invalid JSON, or contains invalid required fields.
 */
async function loadManifest(projectDir) {
  const manifestPath = join(projectDir, SRC_DIR, MANIFEST_FILE);
  let raw;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch {
    throw new Error(
      `Missing manifest file ${manifestPath}. A ${MANIFEST_FILE} file is required.`,
    );
  }

  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Manifest ${manifestPath} is not valid JSON: ${error.message}`,
      { cause: error },
    );
  }

  const checks = [
    [
      "class",
      (value) =>
        typeof value === "string" &&
        value.length > 0 &&
        JS_IDENTIFIER.test(value),
      `a valid JavaScript identifier (${JS_IDENTIFIER.toString()})`,
    ],
    [
      "id",
      (value) =>
        typeof value === "string" &&
        value.length > 0 &&
        EXTENSION_ID.test(value) &&
        !value.includes(".."),
      `a string matching ${EXTENSION_ID.toString()} with no ".." sequences`,
    ],
    [
      "version",
      (value) =>
        typeof value === "string" &&
        value.length > 0 &&
        EXTENSION_ID.test(value) &&
        !value.includes(".."),
      `a string matching ${EXTENSION_ID.toString()} with no ".." sequences`,
    ],
  ];

  for (const [field, test, expectation] of checks) {
    if (!test(manifest[field])) {
      throw new Error(
        `The manifest field ${JSON.stringify(field)} must be ${expectation} (got ${JSON.stringify(manifest[field])}).`,
      );
    }
  }

  return manifest;
}

/**
 * Extract the names exported by an entry module.
 * @param {Object} entryModule - The parsed entry module.
 * @return {string[]} The exported names.
 */
function entryExportNames(entryModule) {
  const names = [];
  for (const node of entryModule.ast.body) {
    if (node.type === "ExportNamedDeclaration") {
      if (node.declaration) {
        if (
          node.declaration.type === "FunctionDeclaration" &&
          node.declaration.id
        )
          names.push(node.declaration.id.name);
        if (node.declaration.type === "ClassDeclaration" && node.declaration.id)
          names.push(node.declaration.id.name);
        if (node.declaration.type === "VariableDeclaration") {
          for (const declarator of node.declaration.declarations) {
            if (declarator.id.type === "Identifier")
              names.push(declarator.id.name);
          }
        }
      }
      for (const specifier of node.specifiers ?? []) {
        if (specifier.type === "ExportSpecifier") {
          names.push(
            specifier.exported.type === "Identifier"
              ? specifier.exported.name
              : specifier.exported.value,
          );
        }
      }
    } else if (
      node.type === "ExportDefaultDeclaration" &&
      node.declaration.id
    ) {
      names.push(node.declaration.id.name);
    }
  }
  return names;
}

/**
 * Extract the declaration from an export statement.
 * @param {Object} node - The AST node to unwrap.
 * @return {Object|null} The exported declaration, the original node when it is not an export statement, or `null` when the export has no declaration.
 */
function unwrapExport(node) {
  if (
    node.type === "ExportNamedDeclaration" ||
    node.type === "ExportDefaultDeclaration"
  ) {
    return node.declaration ?? null;
  }
  return node;
}

/**
 * Collect top-level function, class, and simple variable bindings from bundled modules.
 * @param {Array} modules - Parsed modules whose top-level declarations are indexed.
 * @returns {{functions: Map, other: Map}} Maps of function bindings and other bindings.
 * @throws {Error} If multiple modules define the same binding name.
 */
function collectTopLevelBindings(modules) {
  const functions = new Map();
  const other = new Map();

  for (const mod of modules) {
    for (const bodyNode of mod.ast.body) {
      const node = unwrapExport(bodyNode);
      if (!node) continue;
      if (node.type === "FunctionDeclaration" && node.id) {
        const name = node.id.name;
        if (functions.has(name)) {
          throw new Error(
            `Duplicate binding "${name}" found in ${mod.path} and ${functions.get(name).mod.path}.`,
          );
        }
        functions.set(name, { node, mod });
      } else if (node.type === "ClassDeclaration" && node.id) {
        const name = node.id.name;
        if (other.has(name)) {
          throw new Error(
            `Duplicate binding "${name}" found in ${mod.path} and ${other.get(name).mod.path}.`,
          );
        }
        other.set(name, { node, mod });
      } else if (node.type === "VariableDeclaration") {
        for (const declarator of node.declarations) {
          if (declarator.id.type === "Identifier") {
            const name = declarator.id.name;
            if (other.has(name)) {
              throw new Error(
                `Duplicate binding "${name}" found in ${mod.path} and ${other.get(name).mod.path}.`,
              );
            }
            other.set(name, { node, mod });
          }
        }
      }
    }
  }

  return { functions, other };
}

/**
 * Collects function names that serve as entry points for reachability analysis.
 * @param {Object} context - Root collection context.
 * @param {Object} context.entryModule - Entry module containing exported names.
 * @param {Object} context.manifest - Project manifest.
 * @param {Map<string, *>} context.functions - Available function bindings.
 * @param {Set<string>} context.opcodes - Manifest-associated opcode names.
 * @return {Set<string>} Function names selected as reachability roots.
 */
function collectRoots({ entryModule, manifest, functions, opcodes }) {
  const roots = new Set();
  for (const name of entryExportNames(entryModule)) {
    if (functions.has(name)) roots.add(name);
    if (opcodes.has(name)) roots.add(name);
  }
  for (const opcode of opcodes) {
    if (functions.has(opcode)) roots.add(opcode);
  }
  return roots;
}

/**
 * Collects block opcodes defined in a manifest.
 * @param {Object} manifest - The extension manifest containing block definitions.
 * @return {Set<string>} The set of block opcode names.
 */
function manifestOpcodes(manifest) {
  const opcodes = new Set();
  if (Array.isArray(manifest.blocks)) {
    for (const block of manifest.blocks) {
      if (typeof block === "string") {
        opcodes.add(block);
      } else if (
        block &&
        typeof block === "object" &&
        typeof block.opcode === "string"
      ) {
        opcodes.add(block.opcode);
      }
    }
  }
  return opcodes;
}

/**
 * Determines which functions and declarations are reachable from the extension entry points.
 * @param {Object} params - Reachability analysis inputs.
 * @param {Array} params.modules - Parsed project modules to analyze.
 * @param {Object} params.entryModule - Parsed entry module containing exported roots.
 * @param {Object} params.manifest - Extension manifest containing block metadata.
 * @param {string} params.runtimeGlobal - Runtime global identifier to exclude from local references.
 * @return {Object} Reachability results, including retained functions, retained declarations, extension method functions, and indexed bindings.
 */
function computeReachability({
  modules,
  entryModule,
  manifest,
  runtimeGlobal,
}) {
  const { functions, other } = collectTopLevelBindings(modules);
  const knownOpcodes = manifestOpcodes(manifest);

  const retainedFunctions = new Set();
  const retainedDecls = new Set();
  const methodFunctions = new Set();

  const roots = collectRoots({
    entryModule,
    manifest,
    functions,
    opcodes: knownOpcodes,
  });
  const queue = [];
  for (const root of roots) {
    queue.push({ kind: "function", name: root });
    if (functions.has(root)) methodFunctions.add(root);
  }

  while (queue.length > 0) {
    const { kind, name } = queue.shift();
    if (kind === "function") {
      if (retainedFunctions.has(name) || !functions.has(name)) continue;
      retainedFunctions.add(name);
      const { node } = functions.get(name);
      const { uses, opcodes } = analyzeNode(node, runtimeGlobal);
      for (const use of uses) {
        if (functions.has(use) && !retainedFunctions.has(use))
          queue.push({ kind: "function", name: use });
        if (other.has(use) && !retainedDecls.has(use))
          queue.push({ kind: "decl", name: use });
      }
      for (const opcode of opcodes) {
        if (functions.has(opcode) && !retainedFunctions.has(opcode)) {
          methodFunctions.add(opcode);
          queue.push({ kind: "function", name: opcode });
        }
      }
    } else {
      if (retainedDecls.has(name) || !other.has(name)) continue;
      retainedDecls.add(name);
      const { node } = other.get(name);
      const { uses } = analyzeNode(node, runtimeGlobal);
      for (const use of uses) {
        if (functions.has(use) && !retainedFunctions.has(use))
          queue.push({ kind: "function", name: use });
        if (other.has(use) && !retainedDecls.has(use))
          queue.push({ kind: "decl", name: use });
      }
    }
  }

  return {
    retainedFunctions,
    retainedDecls,
    methodFunctions,
    functions,
    other,
  };
}

/**
 * Finds runtime asset references in bundled modules.
 * @param {Object} input - Asset scan inputs.
 * @param {Array} input.modules - Parsed modules to inspect.
 * @param {string} input.runtimeGlobal - Runtime global identifier used for asset access.
 * @returns {{references: string[], dynamicKeys: string[]}} Static asset keys and dynamic asset access expressions.
 */
function scanAssets({ modules, runtimeGlobal }) {
  const references = [];
  const dynamicKeys = [];

  for (const mod of modules) {
    walk(mod.ast, (node) => {
      if (
        node.type === "MemberExpression" &&
        node.computed &&
        node.object.type === "MemberExpression" &&
        node.object.object.type === "Identifier" &&
        node.object.object.name === runtimeGlobal &&
        node.object.property.type === "Identifier" &&
        node.object.property.name === "assets"
      ) {
        const property = node.property;
        if (property.type === "Literal" && typeof property.value === "string") {
          references.push(property.value);
        } else if (property.type === "Identifier") {
          dynamicKeys.push(`${runtimeGlobal}.assets[${property.name}]`);
        } else if (property.type === "TemplateLiteral") {
          dynamicKeys.push(`${runtimeGlobal}.assets[template literal]`);
        } else {
          dynamicKeys.push(`${runtimeGlobal}.assets[...]`);
        }
      }
      if (
        node.type === "MemberExpression" &&
        !node.computed &&
        node.object.type === "MemberExpression" &&
        node.object.object.type === "Identifier" &&
        node.object.object.name === runtimeGlobal &&
        node.object.property.type === "Identifier" &&
        node.object.property.name === "assets"
      ) {
        dynamicKeys.push(
          `${runtimeGlobal}.assets.${node.property.type === "Identifier" ? node.property.name : "…"}`,
        );
      }
    });
  }

  const unique = [];
  for (const key of references) {
    if (!unique.includes(key)) unique.push(key);
  }

  return { references: unique, dynamicKeys };
}

/**
 * Loads referenced assets and converts them to base64 data URLs.
 * @param {string} projectDir - The project directory containing the assets directory.
 * @param {string[]} references - Asset filenames to load.
 * @return {Promise<Map<string, string>>} A map of asset filenames to data URLs.
 */
async function loadAssetCandidates(projectDir, references) {
  const assetsDir = join(projectDir, ASSETS_DIR);
  const candidates = new Map();
  let entries;
  try {
    entries = await readdir(assetsDir, { withFileTypes: true });
  } catch {
    return candidates;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!references.includes(entry.name)) continue;
    const file = join(assetsDir, entry.name);
    const data = await readFile(file);
    const mime =
      MIME_TYPES.get(extname(entry.name).toLowerCase()) ??
      "application/octet-stream";
    candidates.set(
      entry.name,
      `data:${mime};base64,${data.toString("base64")}`,
    );
  }
  return candidates;
}

/**
 * Warn about hardcoded extension identifiers or names that differ from manifest metadata.
 * @param {Array} modules - Parsed project modules to inspect.
 * @param {Object} manifest - Extension manifest containing the expected `id` and `name`.
 * @param {string[]} warnings - Collection to which mismatch warnings are appended.
 * @param {string} runtimeGlobal - Runtime global name used in the recommended metadata access.
 */
function checkHardcodedIdName({ modules, manifest, warnings, runtimeGlobal }) {
  for (const mod of modules) {
    walk(mod.ast, (node) => {
      if (node.type !== "ObjectExpression") return;
      for (const property of node.properties) {
        if (property.type !== "Property") continue;
        let keyName = null;
        if (property.key.type === "Identifier") keyName = property.key.name;
        else if (
          property.key.type === "Literal" &&
          typeof property.key.value === "string"
        )
          keyName = property.key.value;
        if (keyName !== "id" && keyName !== "name") continue;
        if (property.shorthand) continue;
        if (
          !property.value ||
          property.value.type !== "Literal" ||
          typeof property.value.value !== "string"
        )
          continue;
        if (
          keyName === "id" &&
          typeof manifest.id === "string" &&
          property.value.value === manifest.id
        )
          continue;
        if (
          keyName === "name" &&
          typeof manifest.name === "string" &&
          property.value.value === manifest.name
        )
          continue;
        if (keyName === "id") {
          warnings.push(
            `Hardcoded id "${property.value.value}" in ${mod.path} does not match the manifest's id (${JSON.stringify(manifest.id)}). Use ${runtimeGlobal}.meta.id instead.`,
          );
        } else {
          warnings.push(
            `Hardcoded name "${property.value.value}" in ${mod.path} does not match the manifest's name (${JSON.stringify(manifest.name)}). Use ${runtimeGlobal}.meta.name instead.`,
          );
        }
      }
    });
  }
}

/**
 * Adds warnings for differences between selected package metadata and manifest fields.
 * @param {string} projectDir - The project directory containing package.json.
 * @param {object} manifest - The extension manifest to compare against.
 * @param {string[]} warnings - The array to receive metadata difference warnings.
 */
async function checkPackageJson(projectDir, manifest, warnings) {
  let packageJson;
  try {
    packageJson = JSON.parse(
      await readFile(join(projectDir, "package.json"), "utf8"),
    );
  } catch {
    return;
  }
  if (!packageJson || typeof packageJson !== "object") return;

  for (const field of ["version", "license", "description"]) {
    if (typeof packageJson[field] !== "string") continue;
    if (
      typeof manifest[field] === "string" &&
      packageJson[field] !== manifest[field]
    ) {
      warnings.push(
        `package.json ${field} (${JSON.stringify(packageJson[field])}) differs from the manifest's ${field} (${JSON.stringify(manifest[field])}).`,
      );
    }
  }
}

/**
 * Builds the embedded asset map for statically referenced runtime assets.
 * @param {Iterable<string>} references - Asset keys referenced by the extension.
 * @param {Map<string, string>} candidates - Available asset keys and their data URLs.
 * @param {string} runtimeGlobal - Runtime global name used in missing-asset errors.
 * @returns {Object<string, string>} The asset keys mapped to their data URLs.
 */
function buildAssetsObject(references, candidates, runtimeGlobal) {
  const assets = {};
  for (const key of references) {
    if (!candidates.has(key)) {
      throw new Error(
        `Referenced asset ${JSON.stringify(key)} does not exist in the ${ASSETS_DIR}/ directory. Every ${runtimeGlobal}.assets["..."] reference must resolve to a real file.`,
      );
    }
    assets[key] = candidates.get(key);
  }
  return assets;
}

/**
 * Converts a function declaration into class-method source while preserving its name, parameters, body, and async or generator status.
 * @param {Object} fn - The function declaration to convert.
 * @param {string} source - The source text containing the function declaration.
 * @return {string} The equivalent class-method source.
 */
function methodSource(fn, source) {
  const parts = [];
  if (fn.async) parts.push("async");
  if (fn.generator) parts.push("*");
  parts.push(`${fn.id.name}`);
  const params = fn.params.length
    ? source.slice(fn.params[0].start, fn.params[fn.params.length - 1].end)
    : "";
  const body = source.slice(fn.body.start, fn.body.end);
  return `${parts.join(" ")}(${params}) ${body}`;
}

/**
 * Removes an export declaration prefix from source text.
 * @param {string} text - The source text to process.
 * @return {string} The source text without an `export` or `export default` prefix.
 */
function stripsExport(text) {
  if (text.startsWith("export default "))
    return text.slice("export default ".length);
  if (text.startsWith("export ")) return text.slice("export ".length);
  return text;
}

/**
 * Assembles the generated Scratch extension source.
 * @param {Object} options - Assembly inputs.
 * @param {Object} options.manifest - Extension metadata.
 * @param {Object} options.assets - Embedded asset data.
 * @param {string[]} options.methods - Class method source strings.
 * @param {string[]} options.otherDecls - Additional declaration source strings.
 * @param {string} options.runtimeGlobal - Name of the runtime data variable.
 * @return {string} The complete extension source.
 */
function assemble({ manifest, assets, methods, otherDecls, runtimeGlobal }) {
  const head = [];
  head.push("(function (Scratch) {");
  head.push('  "use strict";');
  head.push("");
  head.push(`  const ${runtimeGlobal} = {`);
  head.push(`    meta: ${JSON.stringify(manifest, null, 2)},`);
  head.push(`    assets: ${JSON.stringify(assets, null, 2)}`);
  head.push("  };");
  for (const decl of otherDecls) {
    head.push("");
    head.push(`  ${decl}`);
  }
  head.push("");
  head.push(`  class ${manifest.class} {`);
  for (const method of methods) {
    head.push(`    ${method}`);
    head.push("");
  }
  if (methods.length > 0) head.pop();
  head.push("  }");
  head.push("");
  head.push(`  Scratch.extensions.register(new ${manifest.class}());`);
  head.push("})(Scratch);");

  return head.join("\n") + "\n";
}

/**
 * Builds a Scratch extension bundle from a project directory.
 * @param {string} [projectDir=process.cwd()] - The project directory containing the source files and manifest.
 * @param {object} [options={}] - Build configuration and dependencies.
 * @returns {Promise<object>} The output file path, warnings, formatted bundle, and retained bindings.
 */
export async function build(projectDir = process.cwd(), options = {}) {
  const logger = options.logger ?? createLogger();
  const product = options.product ?? (await loadProduct());
  const { runtimeGlobal } = product;

  const manifest = await loadManifest(projectDir);
  const modules = await bundleModules(projectDir);
  const entryModule = modules.find((module) => module.isEntry);

  const warnings = [];
  checkHardcodedIdName({ modules, manifest, warnings, runtimeGlobal });
  await checkPackageJson(projectDir, manifest, warnings);

  const { references, dynamicKeys } = scanAssets({ modules, runtimeGlobal });
  if (dynamicKeys.length > 0) {
    throw new Error(
      `Asset keys must be static string literals (e.g. ${runtimeGlobal}.assets["icon.png"]) so assets can be tree-shaken. Found dynamic asset access: ${dynamicKeys.join(", ")}.`,
    );
  }

  const { retainedFunctions, retainedDecls, methodFunctions } =
    computeReachability({ modules, entryModule, manifest, runtimeGlobal });

  const methods = [];
  const otherDecls = [];
  const emitted = new Set();
  const emittedDecls = new Set();

  for (const mod of [
    entryModule,
    ...modules.filter((m) => m !== entryModule),
  ]) {
    for (const bodyNode of mod.ast.body) {
      const node = unwrapExport(bodyNode);
      if (!node) continue;
      if (node.type !== "FunctionDeclaration" || !node.id) continue;
      const name = node.id.name;
      if (!retainedFunctions.has(name) || emitted.has(name)) continue;
      if (methodFunctions.has(name)) {
        methods.push(methodSource(node, mod.source));
      } else {
        otherDecls.push(stripsExport(mod.source.slice(node.start, node.end)));
      }
      emitted.add(name);
    }
  }

  for (const mod of modules) {
    for (const bodyNode of mod.ast.body) {
      const node = unwrapExport(bodyNode);
      if (!node) continue;
      if (
        node.type !== "VariableDeclaration" &&
        node.type !== "ClassDeclaration"
      )
        continue;
      const declarators =
        node.type === "VariableDeclaration" ? node.declarations : [node];
      for (const declarator of declarators) {
        const id =
          declarator.type === "VariableDeclarator"
            ? declarator.id.type === "Identifier"
              ? declarator.id.name
              : null
            : declarator.id.type === "Identifier"
              ? declarator.id.name
              : null;
        if (id && retainedDecls.has(id) && !emittedDecls.has(id)) {
          otherDecls.push(stripsExport(mod.source.slice(node.start, node.end)));
          emittedDecls.add(id);
          break;
        }
      }
    }
  }

  const candidates = await loadAssetCandidates(projectDir, references);
  const assets = buildAssetsObject(references, candidates, runtimeGlobal);

  for (const warning of warnings) {
    logger.warn(warning);
  }

  const raw = assemble({
    manifest,
    assets,
    methods,
    otherDecls,
    runtimeGlobal,
  });

  let formatted;
  try {
    formatted = await prettier.format(raw, {
      parser: "babel",
      singleQuote: false,
      trailingComma: "all",
      objectWrap: "collapse",
    });
  } catch (error) {
    throw new Error(`Failed to format compiled output: ${error.message}`, {
      cause: error,
    });
  }

  const distDir = join(projectDir, DIST_DIR);
  await mkdir(distDir, { recursive: true });
  const outFile = join(distDir, `${manifest.id}@${manifest.version}.js`);
  await writeFile(outFile, formatted, "utf8");

  logger.success(`Wrote ${outFile}`);
  return {
    file: outFile,
    warnings,
    output: formatted,
    retainedFunctions,
    retainedDecls,
  };
}
