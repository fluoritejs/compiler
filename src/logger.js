/**
 * Creates a logger that writes formatted messages to configurable output and error streams.
 * @param {Object} [options] - Logger configuration.
 * @param {NodeJS.WritableStream} [options.out=process.stdout] - Stream for success and skipped messages.
 * @param {NodeJS.WritableStream} [options.err=process.stderr] - Stream for error and warning messages.
 * @param {boolean|{out?: boolean, err?: boolean}} [options.color=false] - Enables coloring globally or separately for each stream.
 * @returns {{error(message: string): void, warn(message: string): void, success(message: string): void, skip(message: string): void}} Logger methods for writing formatted messages.
 */
export function createLogger({
  out = process.stdout,
  err = process.stderr,
  color = false,
} = {}) {
  const outColor =
    typeof color === "object" && color !== null ? !!color.out : !!color;
  const errColor =
    typeof color === "object" && color !== null ? !!color.err : !!color;
  const outStyle = (open, close) => (string) =>
    outColor ? `${open}${string}${close}` : string;
  const outDim = outStyle("\u001b[2m", "\u001b[22m");

  return {
    error(message) {
      err.write(
        `${errColor ? "\u001b[31m" : ""}✗${errColor ? "\u001b[39m" : ""} ${message}\n`,
      );
    },
    warn(message) {
      err.write(
        `${errColor ? "\u001b[33m" : ""}!${errColor ? "\u001b[39m" : ""} ${message}\n`,
      );
    },
    success(message) {
      out.write(
        `${outColor ? "\u001b[32m" : ""}✓${outColor ? "\u001b[39m" : ""} ${message}\n`,
      );
    },
    skip(message) {
      out.write(`${outDim("-")} ${message}\n`);
    },
  };
}
