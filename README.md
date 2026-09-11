# Fluorite Compiler

Compile multiple JavaScript modules into a single [TurboWarp](https://turbowarp.org/) extension file, and publish it to a [Fluorite Registry](https://github.com/fluoritejs/registry).

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

# publish it to a registry
fluorite-compiler login my-namespace
fluorite-compiler publish
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

| Command   | Description                                                                            |
| --------- | -------------------------------------------------------------------------------------- |
| `init`    | Scaffold `src/`, `assets/`, and starter files in `[project-dir]` (defaults to cwd).    |
| `build`   | Bundle, tree-shake, embed assets, and write `dist/<id>@<version>.js`.                  |
| `login`   | Sign in to a registry and store the session.                                           |
| `logout`  | Clear the stored registry session.                                                     |
| `status`  | Show the signed-in user for the default registry.                                      |
| `publish` | Build the project, check the version against the registry, and push the compiled file. |
| `search`  | Search the registry for extensions.                                                    |
| `yank`    | Mark a published version as yanked (hidden from default listings).                     |
| `unyank`  | Reverse a `yank`.                                                                      |

| Flag                 | Description                               |
| -------------------- | ----------------------------------------- |
| `--registry <url>`   | Registry to use (defaults to stored).     |
| `--token <token>`    | Auth token; overrides the stored session. |
| `--namespace <name>` | Publish/yank namespace override.          |
| `--config <path>`    | Config file path.                         |
| `--reason <text>`    | Reason attached to a `yank`.              |
| `-h`, `--help`       | Show usage information.                   |
| `-V`, `--version`    | Print the compiler version.               |

## Registry commands

Credentials are stored in `~/.config/fluorite/compiler.json` (or `$XDG_CONFIG_HOME/fluorite/compiler.json`).

```bash
# sign in with namespace + password (prompt is masked)
fluorite-compiler login alice --registry https://registry.example.com

# or use an automation token (exempt from terms acceptance)
fluorite-compiler login alice --token <token>

fluorite-compiler status
fluorite-compiler publish
fluorite-compiler yank 1.0.0 --reason "Security issue"
fluorite-compiler unyank 1.0.0
fluorite-compiler search scratch
```

`publish` reads `id` and `version` from `src/99-manifest.json`, builds the project, then refuses to push if the version is not greater than the registry's latest. The registry may hold the push in review — the command reports whether the version was published or is pending approval. Registry error codes carry hints (for example, bump the version, or accept the terms of service).

## Development

```bash
npm install      # install dependencies
npm run lint     # ESLint
npm run format   # auto-format with Prettier
npm run test     # run the node:test suite
```

`npm run format:check` and `npm run lint` are enforced in CI for every push and pull request.

## License

Fluorite Compiler is Free Software under the [Apache 2.0](LICENSE) license.
