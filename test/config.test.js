import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Config, DEFAULTS, createConfig } from "../src/index.js";

// Мини-замена schemastery: записывает цепочку вызовов, чтобы проверить форму схемы
// без сети. Реальные границы/значения по умолчанию проверяются ниже, если
// @deepseek-ai/schemastery установлен (devDependency).
function fakeZ({ withVolatile = true } = {}) {
  const node = (kind) => {
    const calls = { kind, default: undefined, description: undefined, volatile: false, min: undefined, max: undefined };
    const api = {
      calls,
      step() { return api; },
      min(v) { calls.min = v; return api; },
      max(v) { calls.max = v; return api; },
      default(v) { calls.default = v; return api; },
      description(v) { calls.description = v; return api; },
      extra(key, value) { if (key === "volatile") calls.volatile = value; return api; },
    };
    if (withVolatile) api.volatile = () => { calls.volatile = true; return api; };
    return api;
  };
  return { object: (fields) => ({ fields }), number: () => node("number"), boolean: () => node("boolean") };
}

describe("Config (схема настроек для DSH 0.2.x)", () => {
  it("без schemastery Config не создаётся, а модуль всё равно загружается", () => {
    assert.equal(createConfig(undefined), undefined);
    assert.equal(createConfig({}), undefined);
  });

  it("каждое поле помечено volatile (иначе настройки не показываются в форме)", () => {
    for (const withVolatile of [true, false]) {
      const { fields } = createConfig(fakeZ({ withVolatile }));
      assert.deepEqual(Object.keys(fields).sort(), ["maxDelayMs", "retryQuota", "retryUnknown", "unknownMaxRetries"]);
      for (const [name, field] of Object.entries(fields)) {
        assert.equal(field.calls.volatile, true, `${name} must be volatile (withVolatile=${withVolatile})`);
        assert.ok(field.calls.description?.length > 10, `${name} needs a description`);
      }
    }
  });

  it("значения по умолчанию в схеме совпадают с DEFAULTS и cordis.patch.yml", () => {
    const { fields } = createConfig(fakeZ());
    for (const [name, field] of Object.entries(fields)) {
      assert.equal(field.calls.default, DEFAULTS[name], name);
    }
    assert.deepEqual({ ...DEFAULTS }, {
      maxDelayMs: 60000,
      retryQuota: false,
      retryUnknown: true,
      unknownMaxRetries: 3,
    });
  });

  it("границы: maxDelayMs 1000..2147483647, unknownMaxRetries 0..100", () => {
    const { fields } = createConfig(fakeZ());
    assert.deepEqual([fields.maxDelayMs.calls.min, fields.maxDelayMs.calls.max], [1000, 2147483647]);
    assert.deepEqual([fields.unknownMaxRetries.calls.min, fields.unknownMaxRetries.calls.max], [0, 100]);
  });

  it("с реальным schemastery: значения по умолчанию и валидация", { skip: Config === undefined && "@deepseek-ai/schemastery не установлен" }, () => {
    assert.deepEqual(JSON.parse(JSON.stringify(Config({}))), { ...DEFAULTS });
    assert.throws(() => Config({ maxDelayMs: 10 }));
    assert.throws(() => Config({ unknownMaxRetries: 101 }));
  });
});
