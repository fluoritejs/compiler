export function createLogger({ out = process.stdout, err = process.stderr, color = false } = {}) {
  const style = (open, close) => (string) => (color ? `${open}${string}${close}` : string);
  const dim = style("\u001b[2m", "\u001b[22m");

  return {
    error(message) {
      err.write(`${color ? "\u001b[31m" : ""}✗${color ? "\u001b[39m" : ""} ${message}\n`);
    },
    warn(message) {
      err.write(`${color ? "\u001b[33m" : ""}!${color ? "\u001b[39m" : ""} ${message}\n`);
    },
    success(message) {
      out.write(`${color ? "\u001b[32m" : ""}✓${color ? "\u001b[39m" : ""} ${message}\n`);
    },
    skip(message) {
      out.write(`${dim("-")} ${message}\n`);
    },
  };
}