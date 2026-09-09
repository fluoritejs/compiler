/**
 * Returns a logger whose methods write to `out`/`err` with optional ANSI color.
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
