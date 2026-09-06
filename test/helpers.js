import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function makeTempProject(t) {
  const dir = await mkdtemp(join(tmpdir(), "fluorite-test-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  await mkdir(join(dir, "src"), { recursive: true });
  await mkdir(join(dir, "assets"), { recursive: true });
  return dir;
}

export async function writeFileRel(dir, relative, content) {
  const path = join(dir, relative);
  await mkdir(join(dir, relative.split("/").slice(0, -1).join("/")), { recursive: true });
  await writeFile(path, content, "utf8");
}

export function silentLogger() {
  const errors = [];
  const warnings = [];
  const messages = [];
  const logger = {
    error(message) {
      errors.push(message);
      messages.push(message);
    },
    warn(message) {
      warnings.push(message);
      messages.push(message);
    },
    success(message) {
      messages.push(message);
    },
    skip(message) {
      messages.push(message);
    },
  };
  return { logger, errors, warnings, messages };
}