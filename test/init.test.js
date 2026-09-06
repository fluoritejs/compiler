import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  ICON_TEMPLATE,
  MANIFEST_TEMPLATE,
  entryTemplate,
  helloWorldTemplate,
  init,
} from "../src/index.js";
import { makeTempProject, silentLogger } from "./helpers.js";

const EXPECTED_FILES = [
  join("src", "01-hello-world.js"),
  join("src", "00-index.js"),
  join("src", "99-manifest.json"),
  join("assets", "hello-icon.svg"),
];

function toPosix(path) {
  return path.split(sep).join("/");
}

describe("init", () => {
  it("scaffolds exactly the expected files", async (t) => {
    const dir = await makeTempProject(t);
    const { logger, errors, messages } = silentLogger();

    const result = await init(dir, { logger });

    const created = result.created
      .map((file) => toPosix(relative(dir, file)))
      .sort();
    assert.deepEqual(created, EXPECTED_FILES.map(toPosix).sort());
    assert.equal(errors.length, 0);

    for (const file of result.created) {
      assert.ok(
        messages.some((message) =>
          message.includes(`Created ${toPosix(file)}`),
        ),
        `expected a Created message for ${file}`,
      );
    }

    assert.equal(
      await readFile(join(dir, "src/99-manifest.json"), "utf8"),
      MANIFEST_TEMPLATE,
    );
    assert.equal(
      await readFile(join(dir, "src/00-index.js"), "utf8"),
      entryTemplate("Fluorite"),
    );
    assert.equal(
      await readFile(join(dir, "src/01-hello-world.js"), "utf8"),
      helloWorldTemplate(),
    );
    assert.equal(
      await readFile(join(dir, "assets/hello-icon.svg"), "utf8"),
      ICON_TEMPLATE,
    );

    for (const file of EXPECTED_FILES) {
      assert.ok(existsSync(join(dir, file)), `expected ${file} to exist`);
    }
  });

  it("re-running init skips existing files with a message and no error", async (t) => {
    const dir = await makeTempProject(t);
    const { logger, errors, messages } = silentLogger();

    const first = await init(dir, { logger });
    assert.equal(first.created.length, 4);
    assert.equal(first.skipped.length, 0);

    const second = await init(dir, { logger });

    assert.equal(second.created.length, 0);
    assert.equal(second.skipped.length, 4);
    assert.equal(errors.length, 0);

    const skippedRelative = second.skipped
      .map((file) => toPosix(relative(dir, file)))
      .sort();
    assert.deepEqual(skippedRelative, EXPECTED_FILES.map(toPosix).sort());

    for (const file of second.skipped) {
      assert.ok(
        messages.some((message) =>
          message.includes(`Skipped ${toPosix(file)} (already exists)`),
        ),
        `expected a skip message for ${file}`,
      );
    }
  });
});
