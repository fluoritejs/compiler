# Fluorite Compiler — API

## `init(targetDir?, options?)`

Scaffolds a fresh extension project in `targetDir` (defaults to `process.cwd()`).

```js
const { created, skipped } = await init("/path/to/project");
```

**Created files**

| File | Description |
|------|-------------|
| `src/99-manifest.json` | Default manifest for a "Hello World" extension. |
| `src/00-index.js` | Entry point exporting `getInfo()` with one reporter block. |
| `src/01-hello-world.js` | Example module with `hello()` and an unused function. |
| `assets/hello-icon.svg` | Starter SVG icon referenced by `getInfo()`. |

**Options**

| Option | Type | Description |
|--------|------|-------------|
| `logger` | `Logger` | A logger object with `.success()`, `.skip()`, `.warn()`, `.error(message)`. Defaults to `createLogger()`. |
| `product` | `ProductConfig` | Product configuration loaded from `.product.json`. Defaults to `loadProduct()`. |

**Returns**

| Field | Type | Description |
|-------|------|-------------|
| `created` | `string[]` | Absolute paths of newly created files. |
| `skipped` | `string[]` | Absolute paths of files that already existed and were skipped. |

Calling `init()` on a project with existing files does **not** error — it logs a skip line per file and returns the skip list.

---

## `build(targetDir?, options?)`

Compiles the extension project at `targetDir` (defaults to `process.cwd()`).

```js
const { file, output, warnings } = await build("/path/to/project");
```

**Build phases**

1. **Load manifest** — reads `src/99-manifest.json`, validates `class`, `id` (matching `/^[A-Za-z0-9][A-Za-z0-9._-]*$/` with no `..`), and `version`.
2. **Bundle** — resolves relative imports from `src/00-index.js`, concatenates modules, removes import/export statements.
3. **Tree-shake** — computes reachability from entry exports, manifest block opcodes, and call-graph; drops all unreachable functions.
4. **Asset scan** — finds `Fluorite.assets["<key>"]` references; rejects dynamic keys; loads matching files from `assets/` and base64-encodes them.
5. **Assemble** — writes a single IIFE with `Fluorite.meta` (verbatim manifest), `Fluorite.assets` (referenced assets only), and the retained class.
6. **Format** — runs [Prettier](https://prettier.io/) with `babel` parser, `singleQuote: false`, `trailingComma: "all"`, and `objectWrap: "collapse"`.
7. **Write** — saves `dist/<id>@<version>.js`.

**Options**

| Option | Type | Description |
|--------|------|-------------|
| `logger` | `Logger` | A logger object (same shape as `init`). Defaults to `createLogger()`. |
| `product` | `ProductConfig` | Product configuration. Defaults to `loadProduct()`. |

**Returns**

| Field | Type | Description |
|-------|------|-------------|
| `file` | `string` | Absolute path of the written dist file. |
| `output` | `string` | The formatted output content. |
| `warnings` | `string[]` | Warning messages emitted during the build. |
| `retainedFunctions` | `Set<string>` | Names of retained functions (for tooling/testing). |
| `retainedDecls` | `Set<string>` | Names of retained non-function top-level declarations. |

**Errors**

| Condition | Error message |
|-----------|---------------|
| `src/00-index.js` missing | `Missing entry file …` |
| `src/99-manifest.json` missing | `Missing manifest file …` |
| Invalid manifest | `The manifest field "<field>" must be …` |
| Unsupported import | `Unsupported import "…" in …` |
| Circular import | `Circular import detected involving …` |
| Dynamic asset key | `Asset keys must be static string literals …` |

---

## `loadProduct()`

Reads and validates `.product.json` from the compiler's own root directory.

```js
const product = await loadProduct();
// { name: "Fluorite Compiler", bin: "fluorite-compiler", … }
```

**Returns** a `ProductConfig` object:

| Field | Type | Required |
|-------|------|----------|
| `name` | `string` | Yes — product display name. |
| `bin` | `string` | Yes — CLI command name, matching `/^[A-Za-z0-9][A-Za-z0-9._-]*$/`. |
| `runtimeGlobal` | `string` | Yes — runtime global identifier in the compiled IIFE (e.g. `Fluorite`). |
| `description` | `string` | Yes — one-line product description. |

---

## Logger

A `Logger` object implements:

| Method | Description |
|--------|-------------|
| `.success(message)` | Log a success line (prefix: `✓`). |
| `.skip(message)` | Log a skip line (prefix: `-`, dimmed). |
| `.warn(message)` | Log a warning to stderr (prefix: `!`). |
| `.error(message)` | Log an error to stderr (prefix: `✗`). |

`createLogger(options?)` returns a logger with optional ANSI color output.

---

## Warnings

Build warnings are reported via `logger.warn()` and collected in the `warnings` array. Warnings never cause a build to fail.

| Trigger | Message |
|---------|---------|
| Hardcoded `id` in source differs from manifest | `Hardcoded id "…" … Use ${global}.meta.id instead.` |
| Hardcoded `name` in source differs from manifest | `Hardcoded name "…" … Use ${global}.meta.name instead.` |
| `package.json` `version` differs from manifest | `package.json version ("…") differs from the manifest's version ("…").` |
| `package.json` `license` differs from manifest | `package.json license ("…") differs from the manifest's license ("…").` |
| `package.json` `description` differs from manifest | `package.json description ("…") differs from the manifest's description ("…").` |
| `package.json` `name` | **Never warned** — exempt from the consistency check. |
| Referenced asset missing from `assets/` | `Referenced asset "…" does not exist in the assets/ directory.` |