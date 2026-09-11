import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const DEFAULT_REGISTRY = "http://localhost:3000";

export class RegistryError extends Error {
  constructor(message, { code = "UNKNOWN", status = 0, hint = "" } = {}) {
    super(hint ? `${message} ${hint}` : message);
    this.name = "RegistryError";
    this.code = code;
    this.status = status;
    this.hint = hint;
  }
}

export function defaultConfigPath() {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "fluorite", "compiler.json");
}

function normalizeRegistry(registry) {
  const value = String(registry || "").replace(/\/+$/, "");
  if (!/^https?:\/\//.test(value)) {
    throw new Error(
      `Invalid registry URL "${registry}". It must start with http:// or https://.`,
    );
  }
  return value;
}

export async function loadStore(configPath = defaultConfigPath()) {
  let raw;
  try {
    raw = JSON.parse(await readFile(configPath, "utf8"));
  } catch {
    raw = {};
  }
  return {
    registry:
      typeof raw.registry === "string" && raw.registry
        ? normalizeRegistry(raw.registry)
        : DEFAULT_REGISTRY,
    token: typeof raw.token === "string" ? raw.token : "",
    namespace: typeof raw.namespace === "string" ? raw.namespace : "",
    path: configPath,
  };
}

export async function saveStore(
  store,
  configPath = store.path ?? defaultConfigPath(),
) {
  const value = {
    registry: store.registry,
    token: store.token ?? "",
    namespace: store.namespace ?? "",
  };
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify(value, null, 2) + "\n", "utf8");
}

export async function apiRequest(
  registry,
  path,
  { method = "GET", token, headers = {}, body } = {},
) {
  const apiPath = path.startsWith("/v0") ? path : `/v0${path}`;
  const response = await fetch(`${registry}${apiPath}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : body,
  });
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!response.ok) {
    const message =
      typeof data?.error?.message === "string"
        ? data.error.message
        : `Registry returned ${response.status}`;
    throw new RegistryError(message, {
      code: typeof data?.error?.code === "string" ? data.error.code : "UNKNOWN",
      status: response.status,
    });
  }
  return { status: response.status, data };
}

export function semverGt(a, b) {
  const parse = (value) => {
    const [core, pre] = String(value).split("-", 2);
    const parts = core.split(".").map((n) => {
      const parsed = parseInt(n, 10);
      return Number.isNaN(parsed) ? 0 : parsed;
    });
    while (parts.length < 3) parts.push(0);
    return { parts: parts.slice(0, 3), pre, hasPre: pre !== undefined };
  };
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < 3; i++) {
    if (left.parts[i] !== right.parts[i]) return left.parts[i] > right.parts[i];
  }
  if (left.hasPre !== right.hasPre) return !left.hasPre;
  if (left.pre === right.pre) return false;
  const leftParts = left.pre.split(".");
  const rightParts = right.pre.split(".");
  const count = Math.max(leftParts.length, rightParts.length);
  for (let i = 0; i < count; i++) {
    const x = leftParts[i];
    const y = rightParts[i];
    if (x === undefined) return false;
    if (y === undefined) return true;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) {
      if (Number(x) !== Number(y)) return Number(x) > Number(y);
    } else if (xNumeric) {
      return true;
    } else if (yNumeric) {
      return false;
    } else {
      const compared = x.localeCompare(y);
      if (compared !== 0) return compared > 0;
    }
  }
  return false;
}
