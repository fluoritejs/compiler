import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  defaultConfigPath,
  loadStore,
  saveStore,
  semverGt,
  RegistryError,
  login,
  logout,
  status,
  search,
  publish,
  setYanked,
  init,
} from "../src/index.js";
import { makeTempProject, silentLogger } from "./helpers.js";

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      cwd: process.cwd(),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function makeTempConfig(t) {
  const dir = await mkdtemp(join(tmpdir(), "fluorite-config-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return join(dir, "compiler.json");
}

async function createFakeRegistry(t, handlers = {}) {
  const state = { me: [], publish: [], yank: [], login: [], logout: null };
  const server = http.createServer(async (req, res) => {
    const { pathname } = new URL(req.url, "http://localhost");
    const send = (status, json) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(json === undefined ? "" : JSON.stringify(json));
    };
    let body = "";
    for await (const chunk of req) body += chunk;
    const authorization = req.headers.authorization || "";
    const contentType = req.headers["content-type"] || "";

    try {
      if (req.method === "POST" && pathname === "/v0/auth/login") {
        state.login.push({ body, contentType });
        const parsed = JSON.parse(body);
        return send(200, {
          user: {
            namespace: parsed.namespace,
            displayName: "",
            type: "normal",
            trusted: false,
          },
          token: "token-123",
        });
      }
      if (req.method === "POST" && pathname === "/v0/auth/logout") {
        state.logout = { authorization, body };
        return send(204);
      }
      if (req.method === "GET" && pathname === "/v0/auth/me") {
        state.me.push(authorization);
        if (authorization !== "Bearer token-123") {
          return send(401, {
            error: { code: "UNAUTHORIZED", message: "Invalid credentials." },
          });
        }
        return send(
          200,
          handlers.me ?? {
            namespace: "alice",
            displayName: "Alice",
            type: "normal",
            trusted: false,
          },
        );
      }
      if (req.method === "GET" && pathname === "/v0/extensions") {
        return send(200, {
          extensions: handlers.search ?? [],
          nextCursor: null,
        });
      }
      const latestMatch = pathname.match(
        /^\/v0\/extensions\/@(.+)\/(.+)\/versions\/latest$/,
      );
      const publishMatch = pathname.match(
        /^\/v0\/extensions\/@(.+)\/(.+)\/versions$/,
      );
      const yankMatch = pathname.match(
        /^\/v0\/extensions\/@(.+)\/(.+)\/versions\/(.+)\/yank$/,
      );
      if (req.method === "GET" && latestMatch) {
        if (handlers.latest === undefined) {
          return send(404, {
            error: { code: "NOT_FOUND", message: "Unknown version." },
          });
        }
        return send(200, {
          version: handlers.latest,
          status: "published",
          yanked: false,
          downloads: 0,
        });
      }
      if (req.method === "POST" && publishMatch) {
        state.publish.push({ body, authorization, contentType });
        if (authorization !== "Bearer token-123") {
          return send(401, {
            error: { code: "UNAUTHORIZED", message: "Invalid credentials." },
          });
        }
        if (handlers.publishResult) {
          return send(
            handlers.publishResult.status,
            handlers.publishResult.json,
          );
        }
        return send(201, {
          id: decodeURIComponent(publishMatch[2]),
          version: "0.1.0",
          status: "published",
          yanked: false,
          downloads: 0,
          createdAt: new Date().toISOString(),
        });
      }
      if (req.method === "PATCH" && yankMatch) {
        state.yank.push({ body, authorization, version: yankMatch[3] });
        if (authorization !== "Bearer token-123") {
          return send(401, {
            error: { code: "UNAUTHORIZED", message: "Invalid credentials." },
          });
        }
        const parsed = JSON.parse(body);
        return send(200, {
          version: yankMatch[3],
          status: "published",
          yanked: !!parsed.yanked,
          downloads: 0,
        });
      }
      return send(404, { error: { code: "NOT_FOUND", message: "Not found." } });
    } catch (error) {
      return send(500, {
        error: { code: "INTERNAL_ERROR", message: String(error) },
      });
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  server.unref();
  t.after(() => server.close());
  return { url: `http://127.0.0.1:${server.address().port}`, state };
}

describe("semverGt", () => {
  it("compares release versions", () => {
    assert.equal(semverGt("2.0.0", "1.0.0"), true);
    assert.equal(semverGt("1.10.0", "1.9.0"), true);
    assert.equal(semverGt("1.0.0", "1.0.0"), false);
    assert.equal(semverGt("1.5.0", "2.0.0"), false);
  });

  it("treats prereleases as lower than releases", () => {
    assert.equal(semverGt("1.0.0", "1.0.0-beta.1"), true);
    assert.equal(semverGt("1.0.0-beta.2", "1.0.0-beta.1"), true);
    assert.equal(semverGt("1.0.0-alpha", "1.0.0-alpha.1"), false);
  });
});

describe("config store", () => {
  it("defaults to a blank store when the file is missing", async (t) => {
    const configPath = await makeTempConfig(t);
    const store = await loadStore(configPath);
    assert.equal(store.registry, "http://localhost:3000");
    assert.equal(store.token, "");
    assert.equal(store.namespace, "");
    assert.equal(store.path, configPath);
  });

  it("round-trips registry, token, and namespace", async (t) => {
    const configPath = await makeTempConfig(t);
    await saveStore(
      {
        registry: "https://registry.example.com",
        token: "abc",
        namespace: "alice",
      },
      configPath,
    );
    const store = await loadStore(configPath);
    assert.equal(store.registry, "https://registry.example.com");
    assert.equal(store.token, "abc");
    assert.equal(store.namespace, "alice");
  });

  it("strips trailing slashes from a stored registry", async (t) => {
    const configPath = await makeTempConfig(t);
    await saveStore(
      { registry: "http://x.example/", token: "", namespace: "" },
      configPath,
    );
    assert.equal((await loadStore(configPath)).registry, "http://x.example");
  });

  it("resolves the config path from XDG_CONFIG_HOME", (t) => {
    const previous = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = "/tmp/fluorite-xdg-test";
    t.after(() => {
      if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previous;
    });
    assert.equal(
      defaultConfigPath(),
      join("/tmp/fluorite-xdg-test", "fluorite", "compiler.json"),
    );
  });
});

describe("registry commands", () => {
  it("logs in with a token and stores the session", async (t) => {
    const registry = await createFakeRegistry(t);
    const configPath = await makeTempConfig(t);
    const { logger } = silentLogger();

    const result = await login("alice", {
      registry: registry.url,
      token: "token-123",
      configPath,
      logger,
    });

    assert.deepEqual(registry.state.me, ["Bearer token-123"]);
    assert.equal(result.namespace, "alice");
    const store = await loadStore(configPath);
    assert.equal(store.token, "token-123");
    assert.equal(store.namespace, "alice");
    assert.equal(store.registry, registry.url);
  });

  it("logs in with namespace and password through the prompt", async (t) => {
    const registry = await createFakeRegistry(t);
    const configPath = await makeTempConfig(t);
    const { logger } = silentLogger();
    const prompt = () => "supersecret";

    const result = await login("bob", {
      registry: registry.url,
      configPath,
      logger,
      prompt,
    });

    assert.deepEqual(JSON.parse(registry.state.login[0].body), {
      namespace: "bob",
      password: "supersecret",
    });
    const store = await loadStore(configPath);
    assert.equal(store.namespace, "bob");
    assert.equal(store.token, "token-123");
    assert.ok(result.user.namespace);
  });

  it("rejects login without a namespace", async (t) => {
    const registry = await createFakeRegistry(t);
    await assert.rejects(
      () => login("", { registry: registry.url }),
      /requires a namespace/,
    );
  });

  it("rejects a non-http registry URL", async (t) => {
    await assert.rejects(
      () =>
        login("alice", { registry: "ftp://registry.example.com", token: "x" }),
      /Invalid registry URL/,
    );
  });

  it("status reports the signed-in user and refreshes the namespace", async (t) => {
    const registry = await createFakeRegistry(t);
    const configPath = await makeTempConfig(t);
    await saveStore(
      { registry: registry.url, token: "token-123", namespace: "stale" },
      configPath,
    );

    const { logger } = silentLogger();
    const result = await status({ configPath, logger });

    assert.deepEqual(result.user, {
      namespace: "alice",
      displayName: "Alice",
      type: "normal",
      trusted: false,
    });
    const store = await loadStore(configPath);
    assert.equal(store.namespace, "alice");
  });

  it("status without a token fails with guidance", async (t) => {
    const configPath = await makeTempConfig(t);
    await assert.rejects(() => status({ configPath }), /Not logged in/);
  });

  it("logout clears the session and revokes the token", async (t) => {
    const registry = await createFakeRegistry(t);
    const configPath = await makeTempConfig(t);
    await saveStore(
      { registry: registry.url, token: "token-123", namespace: "alice" },
      configPath,
    );

    const { logger } = silentLogger();
    await logout({ configPath, logger });

    assert.equal(registry.state.logout.authorization, "Bearer token-123");
    const store = await loadStore(configPath);
    assert.equal(store.token, "");
    assert.equal(store.namespace, "");
    assert.equal(store.registry, registry.url);
  });

  it("search lists extensions", async (t) => {
    const registry = await createFakeRegistry(t, {
      search: [
        {
          namespace: "alice",
          id: "hello-world",
          latestVersion: "1.0.0",
          description: "Say hello.",
          license: "MIT",
        },
      ],
    });
    const configPath = await makeTempConfig(t);
    const { logger, messages } = silentLogger();

    const result = await search("hello", {
      configPath,
      registry: registry.url,
      logger,
    });

    assert.equal(result.extensions.length, 1);
    assert.ok(messages.some((m) => m.includes("@alice/hello-world 1.0.0")));
  });

  it("publish builds, checks the latest version, and pushes the compiled output", async (t) => {
    const registry = await createFakeRegistry(t, { latest: "0.0.9" });
    const configPath = await makeTempConfig(t);
    const dir = await makeTempProject(t);
    const { logger, errors } = silentLogger();

    await init(dir, { logger });
    await saveStore(
      { registry: registry.url, token: "token-123", namespace: "alice" },
      configPath,
    );

    const result = await publish(dir, { configPath, logger });

    assert.equal(errors.length, 0);
    assert.equal(result.created.status, "published");
    assert.match(result.file, /dist[\\/]helloworld@0\.1\.0\.js$/);
    assert.equal(registry.state.publish.length, 1);
    const sent = registry.state.publish[0];
    assert.equal(sent.authorization, "Bearer token-123");
    assert.match(sent.contentType, /application\/javascript/);
    assert.ok(sent.body.includes("helloworld"));
    assert.ok(sent.body.includes("Scratch.extensions.register"));
  });

  it("publish refuses when the local version is not greater than the latest", async (t) => {
    const registry = await createFakeRegistry(t, { latest: "1.0.0" });
    const configPath = await makeTempConfig(t);
    const dir = await makeTempProject(t);
    const { logger } = silentLogger();

    await init(dir, { logger });
    await saveStore(
      { registry: registry.url, token: "token-123", namespace: "alice" },
      configPath,
    );

    await assert.rejects(
      () => publish(dir, { configPath, logger }),
      (error) => {
        assert.match(
          error.message,
          /is not greater than the registry's latest \(1\.0\.0\)/,
        );
        assert.match(error.message, /Bump the version/);
        return true;
      },
    );
    assert.equal(registry.state.publish.length, 0);
  });

  it("publish annotates registry error codes with guidance", async (t) => {
    const registry = await createFakeRegistry(t, {
      latest: "0.0.5",
      publishResult: {
        status: 400,
        json: {
          error: {
            code: "VERSION_TOO_LOW",
            message:
              "Cannot publish version 0.1.0; a higher version (1.0.0) is already published.",
          },
        },
      },
    });
    const configPath = await makeTempConfig(t);
    const dir = await makeTempProject(t);
    const { logger } = silentLogger();

    await init(dir, { logger });
    await saveStore(
      { registry: registry.url, token: "token-123", namespace: "alice" },
      configPath,
    );

    await assert.rejects(
      () => publish(dir, { configPath, logger }),
      (error) => {
        assert.ok(error instanceof RegistryError);
        assert.equal(error.code, "VERSION_TOO_LOW");
        assert.match(error.message, /Bump the version/);
        return true;
      },
    );
  });

  it("publish without a token fails with guidance", async (t) => {
    const registry = await createFakeRegistry(t);
    const configPath = await makeTempConfig(t);
    const dir = await makeTempProject(t);
    const { logger } = silentLogger();

    await init(dir, { logger });

    await assert.rejects(
      () => publish(dir, { configPath, logger, registry: registry.url }),
      /Not logged in/,
    );
  });

  it("yank and unyank toggle the version state", async (t) => {
    const registry = await createFakeRegistry(t);
    const configPath = await makeTempConfig(t);
    const dir = await makeTempProject(t);
    const { logger } = silentLogger();

    await init(dir, { logger });
    await saveStore(
      { registry: registry.url, token: "token-123", namespace: "alice" },
      configPath,
    );

    const yanked = await setYanked("1.0.0", true, dir, {
      configPath,
      logger,
      reason: "Security issue",
    });
    assert.equal(yanked.yanked, true);
    assert.deepEqual(JSON.parse(registry.state.yank[0].body), {
      yanked: true,
      reason: "Security issue",
    });

    const unyanked = await setYanked("1.0.0", false, dir, {
      configPath,
      logger,
    });
    assert.equal(unyanked.yanked, false);
    assert.equal(registry.state.yank.length, 2);
    assert.deepEqual(JSON.parse(registry.state.yank[1].body), {
      yanked: false,
    });
  });

  it("keeps a compatible store path after login", async (t) => {
    const registry = await createFakeRegistry(t);
    const configPath = await makeTempConfig(t);
    const { logger } = silentLogger();

    await login("alice", {
      registry: registry.url,
      token: "token-123",
      configPath,
      logger,
    });
    const rewritten = await readFile(configPath, "utf8");
    const parsed = JSON.parse(rewritten);
    assert.equal(parsed.registry, registry.url.replace(/\/+$/, ""));
    assert.equal(parsed.token, "token-123");
    assert.equal(parsed.namespace, "alice");

    await writeFile(configPath, JSON.stringify(parsed, null, 4), "utf8");
    assert.equal((await loadStore(configPath)).token, "token-123");
  });
});

describe("registry CLI", () => {
  it("help lists the registry commands", async () => {
    const { code, stdout } = await runCli(["--help"]);
    assert.equal(code, 0);
    for (const command of [
      "login",
      "logout",
      "status",
      "publish",
      "search",
      "yank",
      "unyank",
    ]) {
      assert.ok(stdout.includes(command), `help should mention ${command}`);
    }
  });

  it("login, status, and search work end to end through the CLI", async (t) => {
    const registry = await createFakeRegistry(t, {
      search: [
        {
          namespace: "alice",
          id: "hello-world",
          latestVersion: "1.0.0",
          description: "Say hello.",
          license: "MIT",
        },
      ],
    });
    const configPath = await makeTempConfig(t);

    const loginRes = await runCli([
      "login",
      "alice",
      "--token",
      "token-123",
      "--registry",
      registry.url,
      "--config",
      configPath,
    ]);
    assert.equal(loginRes.code, 0);
    assert.ok(loginRes.stdout.includes("Logged in as @alice"));

    const statusRes = await runCli(["status", "--config", configPath]);
    assert.equal(statusRes.code, 0);
    assert.ok(statusRes.stdout.includes("@alice"));

    const searchRes = await runCli([
      "search",
      "hello",
      "--registry",
      registry.url,
      "--config",
      configPath,
    ]);
    assert.equal(searchRes.code, 0);
    assert.ok(searchRes.stdout.includes("@alice/hello-world 1.0.0"));
  });

  it("exits non-zero with a clear message for an unknown command", async () => {
    const { code, stderr } = await runCli(["frobnicate"]);
    assert.notEqual(code, 0);
    assert.ok(stderr.includes("Unknown command"));
  });

  it("exits non-zero with a clear message for a missing flag value", async () => {
    const { code, stderr } = await runCli(["status", "--token"]);
    assert.notEqual(code, 0);
    assert.ok(stderr.includes("Missing value for --token."));
  });
});
