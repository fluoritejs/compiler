import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { build, init } from "../src/index.js";
import { GOLDEN_OUTPUT } from "./fixtures/golden-output.js";
import { makeTempProject, silentLogger } from "./helpers.js";

const DEFAULT_MANIFEST = {
  class: "HelloWorld",
  name: "It works!",
  id: "helloworld",
  license: "LGPL-2.1",
  authors: [{ name: "Author 1" }],
  originalAuthors: [{ name: "Original Author 1" }],
  description: "A description of the extension.",
  version: "0.1.0",
};

const DEFAULT_ENTRY = `import { hello } from "./01-hello-world.js";

export function getInfo() {
  return {
    id: Fluorite.meta.id,
    name: Fluorite.meta.name,
    blockIconURI: Fluorite.assets["hello-icon.svg"],
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

const DEFAULT_MODULE = `export function hello() {
  return "World!";
}

export function unusedFunction() {
  return "This function is unused and should be removed by the compiler.";
}
`;

const DEFAULT_ASSETS = {
  "hello-icon.svg": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">
  <circle cx="12" cy="12" r="10" fill="#4C97FF" />
</svg>
`,
};

async function writeProject(
  dir,
  {
    entry = DEFAULT_ENTRY,
    module = DEFAULT_MODULE,
    manifest = DEFAULT_MANIFEST,
    assets = DEFAULT_ASSETS,
    packageJson,
  } = {},
) {
  await writeFile(join(dir, "src", "00-index.js"), entry, "utf8");
  await writeFile(join(dir, "src", "01-hello-world.js"), module, "utf8");
  await writeFile(
    join(dir, "src", "99-manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    "utf8",
  );
  for (const [name, content] of Object.entries(assets)) {
    await writeFile(join(dir, "assets", name), content, "utf8");
  }
  if (packageJson) {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify(packageJson, null, 2),
      "utf8",
    );
  }
}

describe("build", () => {
  it("succeeds immediately after init and produces the exact golden output", async (t) => {
    const dir = await makeTempProject(t);
    const { logger, errors, warnings } = silentLogger();

    await init(dir, { logger });
    const result = await build(dir, { logger });

    assert.equal(errors.length, 0);
    assert.equal(warnings.length, 0);
    assert.match(result.file, /dist[\\/]helloworld@0\.1\.0\.js$/);
    assert.equal(result.output, GOLDEN_OUTPUT);
    assert.equal(await readFile(result.file, "utf8"), GOLDEN_OUTPUT);
  });

  it("removes unused functions from the output", async (t) => {
    const dir = await makeTempProject(t);
    const { logger } = silentLogger();

    await init(dir, { logger });
    const result = await build(dir, { logger });

    assert.ok(!result.output.includes("unusedFunction"));
    assert.ok(result.output.includes("hello()"));
    assert.ok(result.output.includes("getInfo()"));
  });

  it("excludes unreferenced assets without changing the output", async (t) => {
    const dir = await makeTempProject(t);
    const { logger } = silentLogger();

    await init(dir, { logger });
    const before = (await build(dir, { logger })).output;

    await writeFile(
      join(dir, "assets", "extra.svg"),
      `<svg xmlns="http://www.w3.org/2000/svg" />\n`,
      "utf8",
    );
    const after = (await build(dir, { logger })).output;

    assert.equal(after, before);
    assert.equal(after, GOLDEN_OUTPUT);
  });

  it("rejects dynamic asset keys as a build error", async (t) => {
    const dir = await makeTempProject(t);
    const entry = `export function getInfo() {
  const key = "hello-icon.svg";
  return {
    blockIconURI: Fluorite.assets[key],
    blocks: [],
  };
}
`;
    await writeProject(dir, { entry });

    const { logger } = silentLogger();
    await assert.rejects(
      () => build(dir, { logger }),
      (error) => {
        assert.match(
          error.message,
          /Asset keys must be static string literals/,
        );
        assert.match(error.message, /tree-shaken/);
        return true;
      },
    );
  });

  it("fails with a clear error when a referenced asset is missing", async (t) => {
    const dir = await makeTempProject(t);
    const entry = `export function getInfo() {
  return {
    blockIconURI: Fluorite.assets["missing-icon.png"],
    blocks: [],
  };
}
`;
    await writeProject(dir, { entry });

    const { logger } = silentLogger();
    await assert.rejects(
      () => build(dir, { logger }),
      (error) => {
        assert.match(error.message, /missing-icon\.png/);
        assert.match(error.message, /does not exist in the assets\/ directory/);
        return true;
      },
    );
  });

  it("warns when hardcoded id/name literals differ from the manifest", async (t) => {
    const dir = await makeTempProject(t);
    const entry = `import { hello } from "./01-hello-world.js";

export function getInfo() {
  return {
    id: "custom-id",
    name: "Custom name",
    blockIconURI: Fluorite.assets["hello-icon.svg"],
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
    await writeProject(dir, { entry });
    const { logger } = silentLogger();

    const result = await build(dir, { logger });

    const idWarning = result.warnings.find((warning) =>
      warning.includes("custom-id"),
    );
    assert.ok(idWarning, "expected an id mismatch warning");
    assert.match(idWarning, /Fluorite\.meta\.id/);

    const nameWarning = result.warnings.find((warning) =>
      warning.includes("Custom name"),
    );
    assert.ok(nameWarning, "expected a name mismatch warning");
    assert.match(nameWarning, /Fluorite\.meta\.name/);
  });

  it("warns on manifest/package.json mismatches and exempts name", async (t) => {
    const dir = await makeTempProject(t);
    await writeProject(dir, {
      packageJson: {
        name: "fluorite-compiler",
        version: "9.9.9",
        license: "MIT",
        description: "An unrelated description.",
      },
    });
    const { logger } = silentLogger();

    const result = await build(dir, { logger });

    assert.ok(
      result.warnings.some(
        (warning) => warning.includes("version") && warning.includes("9.9.9"),
      ),
    );
    assert.ok(
      result.warnings.some(
        (warning) => warning.includes("license") && warning.includes("MIT"),
      ),
    );
    assert.ok(
      result.warnings.some((warning) => warning.includes("description")),
    );

    assert.ok(
      !result.warnings.some((warning) => /package\.json name/.test(warning)),
      "name must be exempt from the package.json consistency check",
    );
  });

  it("fails with a clear error when the entry file is missing", async (t) => {
    const dir = await makeTempProject(t);
    await writeFile(
      join(dir, "src", "99-manifest.json"),
      JSON.stringify(DEFAULT_MANIFEST, null, 2),
      "utf8",
    );

    const { logger } = silentLogger();
    await assert.rejects(
      () => build(dir, { logger }),
      (error) => {
        assert.match(error.message, /Missing entry file/);
        return true;
      },
    );
  });
});
