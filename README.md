# Fluorite Compiler

Compile multiple JavaScript modules into a single [TurboWarp](https://turbowarp.org/) extension file.

## Install

```bash
npm install fluorite-compiler
# or, globally:
npm install -g fluorite-compiler
```

## Quick start

```bash
# scaffold a new extension project
fluorite-compiler init my-extension

# compile it
fluorite-compiler build my-extension
```

The compiled file is written to `dist/<id>@<version>.js`.

## Project layout

```text
my-extension/
├── src/
│   ├── 00-index.js        # entry point — exports getInfo() + block handlers
│   ├── 01-hello-world.js  # your modules, imported by 00-index.js
│   └── 99-manifest.json   # extension metadata (class, id, version, …)
└── assets/
    └── hello-icon.svg     # any referenced files, embedded as base64
```

## CLI

```text
fluorite-compiler <command> [project-dir]
```

| Command | Description                                                                         |
| ------- | ----------------------------------------------------------------------------------- |
| `init`  | Scaffold `src/`, `assets/`, and starter files in `[project-dir]` (defaults to cwd). |
| `build` | Bundle, tree-shake, embed assets, and write `dist/<id>@<version>.js`.               |

| Flag              | Description                 |
| ----------------- | --------------------------- |
| `-h`, `--help`    | Show usage information.     |
| `-V`, `--version` | Print the compiler version. |

## Development

```bash
npm install      # install dependencies
npm run lint     # ESLint
npm run format   # auto-format with Prettier
npm run test     # run the node:test suite
```

`npm run format:check` and `npm run lint` are enforced in CI for every push and pull request.

## License

Fluorite Compiler is proud to be Free Software. It is under the [Apache 2.0](LICENSE) license.
