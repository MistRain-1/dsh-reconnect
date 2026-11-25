import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { satisfies } from "./support/semver-lite.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

// Версии DSH, на которых плагин обязан загружаться / обязан быть отклонён.
const MUST_LOAD = ["0.2.2-rc.1", "0.2.2-rc.5", "0.2.2", "0.2.3-alpha.2"];
const MUST_REJECT = ["0.1.7-rc.2", "0.2.1-rc.5", "0.3.0", "0.3.0-alpha.1"];

describe("манифест плагина для DSH 0.2.x", () => {
  it("объявляет engines.dsh — иначе DSH падает на peerDependencies и пропускает плагин", () => {
    assert.equal(typeof pkg.engines?.dsh, "string");
    assert.ok(pkg.engines.dsh.trim().length > 0);
  });

  it("engines.dsh пускает DSH 0.2.2-rc.5 и соседние версии 0.2.2+", () => {
    for (const version of MUST_LOAD) {
      assert.ok(satisfies(version, pkg.engines.dsh), `${version} must satisfy ${pkg.engines.dsh}`);
    }
  });

  it("engines.dsh не обещает версии, на которых плагин не проверялся", () => {
    for (const version of MUST_REJECT) {
      assert.ok(!satisfies(version, pkg.engines.dsh), `${version} must not satisfy ${pkg.engines.dsh}`);
    }
  });

  it("не объявляет peer-зависимостей на пакеты @deepseek-ai/dsh-* (в 0.2.x часть из них удалена)", () => {
    for (const name of Object.keys(pkg.peerDependencies || {})) {
      assert.ok(!/^@deepseek-ai\/dsh(-|$)/.test(name), `stale DSH peer: ${name}`);
    }
    assert.equal(Object.hasOwn(pkg.peerDependencies || {}, "react"), false);
  });

  it("не подключает клиентскую половину, которой нет в 0.2.x", () => {
    assert.equal(pkg.dsh?.client, undefined);
    assert.equal(Object.hasOwn(pkg.exports, "./client"), false);
    assert.equal(existsSync(join(ROOT, "src", "client.js")), false);
  });

  it("bundle.patch, main и files указывают на существующие файлы", () => {
    assert.equal(pkg.dsh.bundle.patch, "./cordis.patch.yml");
    assert.ok(existsSync(join(ROOT, pkg.dsh.bundle.patch)));
    assert.ok(existsSync(join(ROOT, pkg.main)));
    for (const [key, target] of Object.entries(pkg.exports)) {
      assert.ok(existsSync(join(ROOT, target)), `exports[${key}] -> ${target}`);
    }
    for (const entry of pkg.files) assert.ok(existsSync(join(ROOT, entry)), `files: ${entry}`);
  });

  it("patch вставляет строку reconnect с именем пакета", () => {
    const patch = readFileSync(join(ROOT, "cordis.patch.yml"), "utf8");
    assert.match(patch, /id:\s*reconnect/);
    assert.match(patch, new RegExp(`name:\\s*['"]?${pkg.name}['"]?`));
  });

  it("исходники не используют API, удалённые в DSH 0.2.x", () => {
    const forbidden = [
      /from\s+["']@deepseek-ai\/dsh-settings["']/,
      /settingsNamespace\s*\(/,
      /ctx\.settings\.register/,
      /settingsScope/,
      /settings\.plugin\.item/,
      /dsh-client-web-react/,
      /dsh-client-runtime/,
      /__ModuleLoader__/,
    ];
    for (const file of readdirSync(join(ROOT, "src"))) {
      // комментарии-пояснения исключаем: проверяем только исполняемый код
      const code = readFileSync(join(ROOT, "src", file), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      for (const pattern of forbidden) {
        assert.ok(!pattern.test(code), `${file} uses removed API: ${pattern}`);
      }
    }
  });
});
