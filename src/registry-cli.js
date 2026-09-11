import { createInterface } from "node:readline";
import { readFile } from "node:fs/promises";
import {
  apiRequest,
  loadStore,
  saveStore,
  semverGt,
  RegistryError,
} from "./registry.js";
import { build, loadManifest } from "./build.js";
import { createLogger } from "./logger.js";

const PUBLISH_HINTS = {
  UNAUTHORIZED: "Run `fluorite-compiler login` again or pass a fresh --token.",
  TERMS_ACCEPTANCE_REQUIRED:
    "Automation tokens are exempt from terms acceptance; create one in the registry web UI, then `login --token` with it.",
  VERSION_TOO_LOW: "Bump the version in src/99-manifest.json and rebuild.",
  VERSION_EXISTS: "Choose a higher version in src/99-manifest.json.",
  VERSION_PENDING_REVIEW:
    "Another version is pending review for this namespace; wait for it to be approved or rejected.",
  FORBIDDEN:
    "A token can only publish to its own namespace. Log in as the account that owns this extension.",
  INVALID_MANIFEST: "The compiled output is not a valid registry extension.",
  MANIFEST_MISMATCH:
    "The compiled manifest id differs from the registry package id.",
};

export function promptHidden(question) {
  const stdin = process.stdin;
  const stdout = process.stdout;
  if (typeof stdin.setRawMode !== "function") {
    const rl = createInterface({ input: stdin, output: stdout });
    return new Promise((resolve) => {
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer);
      });
    });
  }
  return new Promise((resolve) => {
    let value = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdout.write(question);
    const onData = (char) => {
      char = String(char);
      if (char === "\r" || char === "\n") {
        cleanup();
        stdout.write("\n");
        resolve(value);
      } else if (char === "\u0003") {
        cleanup();
        process.exit(130);
      } else if (char === "\u007f" || char === "\b") {
        value = value.slice(0, -1);
        stdout.write("\b \b");
      } else {
        value += char;
        stdout.write("*");
      }
    };
    const cleanup = () => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    stdin.on("data", onData);
  });
}

export async function resolveContext({
  configPath,
  registry,
  token,
  namespace,
}) {
  const store = await loadStore(configPath);
  const resolved = registry || store.registry;
  const value = String(resolved).replace(/\/+$/, "");
  if (!/^https?:\/\//.test(value)) {
    throw new Error(
      `Invalid registry URL "${resolved}". It must start with http:// or https://.`,
    );
  }
  return {
    store,
    registry: value,
    token: token || store.token,
    namespace: namespace || store.namespace,
  };
}

export async function login(
  namespace,
  {
    registry,
    token,
    configPath,
    logger = createLogger(),
    prompt = promptHidden,
  } = {},
) {
  if (!namespace) {
    throw new Error(
      "Login requires a namespace: `fluorite-compiler login <namespace>`.",
    );
  }
  const context = await resolveContext({ configPath, registry, token });
  const resolvedRegistry = context.registry;

  let result;
  if (token) {
    const me = await apiRequest(resolvedRegistry, "/auth/me", { token });
    result = { token, user: me.data };
  } else {
    const password = await prompt("Password: ");
    if (!password) {
      throw new Error("Login cancelled: no password provided.");
    }
    const response = await apiRequest(resolvedRegistry, "/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ namespace, password }),
    });
    result = { token: response.data.token, user: response.data.user };
  }

  const stored =
    typeof result.user?.namespace === "string" && result.user.namespace
      ? result.user.namespace
      : namespace;
  await saveStore(
    { registry: resolvedRegistry, token: result.token, namespace: stored },
    configPath,
  );

  logger.success(`Logged in as @${stored} at ${resolvedRegistry}`);
  return {
    registry: resolvedRegistry,
    namespace: stored,
    token: result.token,
    user: result.user,
  };
}

export async function logout({
  configPath,
  registry,
  token,
  logger = createLogger(),
} = {}) {
  const context = await resolveContext({ configPath, registry, token });
  if (context.token) {
    try {
      await apiRequest(context.registry, "/auth/logout", {
        method: "POST",
        token: context.token,
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
    } catch {
      // Best-effort revoke; the local token is cleared regardless.
    }
  }
  await saveStore(
    { registry: context.registry, token: "", namespace: "" },
    configPath,
  );
  logger.success(`Logged out of ${context.registry}`);
  return { registry: context.registry };
}

export async function status({
  configPath,
  registry,
  token,
  logger = createLogger(),
} = {}) {
  const context = await resolveContext({ configPath, registry, token });
  if (!context.token) {
    throw new Error(
      `Not logged in. Run \`fluorite-compiler login\`, or pass --token and --registry.`,
    );
  }
  const user = (
    await apiRequest(context.registry, "/auth/me", { token: context.token })
  ).data;
  if (user.namespace && user.namespace !== context.store.namespace) {
    await saveStore(
      { ...context.store, namespace: user.namespace },
      configPath,
    );
  }
  logger.success(
    `@${user.namespace} (${user.trusted ? "trusted" : "untrusted"} ${user.type})`,
  );
  if (user.displayName) logger.success(`Name: ${user.displayName}`);
  logger.success(`Registry: ${context.registry}`);
  return { user, registry: context.registry };
}

export async function search(
  query,
  { registry, configPath, logger = createLogger() } = {},
) {
  if (!query) {
    throw new Error(
      "Search requires a query: `fluorite-compiler search <query>`.",
    );
  }
  const context = await resolveContext({ configPath, registry });
  const response = await apiRequest(
    context.registry,
    `/extensions?search=${encodeURIComponent(query)}`,
  );
  const extensions = response.data.extensions ?? [];
  if (extensions.length === 0) {
    logger.skip(`No extensions found for "${query}".`);
  }
  for (const ext of extensions) {
    logger.success(
      `@${ext.namespace}/${ext.id} ${ext.latestVersion}  ${ext.description ?? ""}`.trimEnd(),
    );
  }
  return { extensions, registry: context.registry };
}

export async function publish(
  projectDir = process.cwd(),
  { registry, token, namespace, configPath, logger = createLogger() } = {},
) {
  const context = await resolveContext({
    configPath,
    registry,
    token,
    namespace,
  });
  if (!context.token) {
    throw new Error(
      `Not logged in. Run \`fluorite-compiler login\`, or pass --token.`,
    );
  }
  if (!context.namespace) {
    throw new Error(
      "Unknown namespace. Run `fluorite-compiler login` first, or pass --namespace.",
    );
  }

  const manifest = await loadManifest(projectDir);
  const { id, version } = manifest;

  let latest;
  try {
    const latestRes = await apiRequest(
      context.registry,
      `/extensions/@${encodeURIComponent(context.namespace)}/${encodeURIComponent(id)}/versions/latest`,
    );
    latest = latestRes.data;
  } catch (error) {
    if (error instanceof RegistryError && error.status === 404) {
      latest = null;
    } else {
      throw error;
    }
  }
  if (latest && !semverGt(version, latest.version)) {
    throw new Error(
      `Version ${version} is not greater than the registry's latest (${latest.version}) for @${context.namespace}/${id}. Bump the version in src/99-manifest.json and rebuild.`,
    );
  }

  const built = await build(projectDir, { logger });
  const source = await readFile(built.file, "utf8");

  let created;
  try {
    const response = await apiRequest(
      context.registry,
      `/extensions/@${encodeURIComponent(context.namespace)}/${encodeURIComponent(id)}/versions`,
      {
        method: "POST",
        token: context.token,
        headers: { "Content-Type": "application/javascript" },
        body: source,
      },
    );
    created = response.data;
  } catch (error) {
    if (error instanceof RegistryError && PUBLISH_HINTS[error.code]) {
      throw new RegistryError(error.message, {
        code: error.code,
        status: error.status,
        hint: PUBLISH_HINTS[error.code],
      });
    }
    throw error;
  }

  const state =
    created.status === "published"
      ? "published"
      : `pending review (${created.status})`;
  logger.success(`Published @${context.namespace}/${id}@${version} (${state})`);
  return {
    created,
    file: built.file,
    namespace: context.namespace,
    registry: context.registry,
  };
}

export async function setYanked(
  version,
  yanked,
  projectDir = process.cwd(),
  {
    reason,
    registry,
    token,
    namespace,
    configPath,
    logger = createLogger(),
  } = {},
) {
  const context = await resolveContext({
    configPath,
    registry,
    token,
    namespace,
  });
  if (!context.token) {
    throw new Error(
      `Not logged in. Run \`fluorite-compiler login\`, or pass --token.`,
    );
  }
  if (!context.namespace) {
    throw new Error(
      "Unknown namespace. Run `fluorite-compiler login` first, or pass --namespace.",
    );
  }
  const manifest = await loadManifest(projectDir);
  const response = await apiRequest(
    context.registry,
    `/extensions/@${encodeURIComponent(context.namespace)}/${encodeURIComponent(manifest.id)}/versions/${encodeURIComponent(version)}/yank`,
    {
      method: "PATCH",
      token: context.token,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ yanked, ...(yanked && reason ? { reason } : {}) }),
    },
  );
  const state = response.data.yanked ? "yanked" : "un-yanked";
  logger.success(`@${context.namespace}/${manifest.id}@${version} is ${state}`);
  return response.data;
}
