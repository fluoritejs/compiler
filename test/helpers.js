import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Creates a temporary project directory with `src` and `assets` subdirectories.
 * @param {Object} t - Test context used to register automatic cleanup.
 * @return {Promise<string>} The temporary project directory path.
 */
export async function makeTempProject(t) {
  const dir = await mkdtemp(join(tmpdir(), "fluorite-test-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  await mkdir(join(dir, "src"), { recursive: true });
  await mkdir(join(dir, "assets"), { recursive: true });
  return dir;
}

/**
 * Creates an in-memory logger and collections for captured messages.
 * @returns {{logger: Object, errors: Array, warnings: Array, messages: Array}} The logger and arrays containing captured error, warning, and all messages.
 */
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
