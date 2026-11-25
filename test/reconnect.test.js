import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { apply } from "../src/index.js";

/**
 * 模拟 DSH 0.2.x 加载器:volatile 字段以 `{ get() }` 引用传入 apply(ctx, config),
 * 其余字段为普通值。`settings.set` 模拟设置页保存(loader 把新值写进同一个引用)。
 */
function createHarness(config = {}, { volatile = true } = {}) {
  const listeners = new Map();
  let cleanup;
  const values = {
    maxDelayMs: 1000,
    retryQuota: false,
    retryUnknown: true,
    unknownMaxRetries: 3,
    ...config,
  };
  const passed = volatile
    ? Object.fromEntries(Object.keys(values).map((key) => [key, { get: () => values[key] }]))
    : { ...values };
  const settings = {
    get: () => ({ ...values }),
    set(field, value) {
      values[field] = value;
      if (!volatile) passed[field] = value;
      return Promise.resolve();
    },
  };
  const ctx = {
    on(event, listener) {
      listeners.set(event, listener);
      return () => listeners.delete(event);
    },
    effect(factory) {
      cleanup = factory();
    },
  };
  apply(ctx, passed);
  const session = {
    events: [],
    append(type, data) {
      this.events.push({ type, data });
    },
  };
  const agent = { session };
  const signal = new AbortController();
  const requestError = (failure, extra = {}) => listeners.get("agent/request-error")({
    agent,
    turn: 1,
    step: 1,
    provider: "fixture",
    failure,
    signal: extra.signal || signal.signal,
    retryPolicy: extra.retryPolicy,
  }, () => ({ kind: "next" }));
  return {
    agent,
    session,
    settings,
    signal,
    requestError,
    async dispose() {
      await cleanup?.();
    },
  };
}

function failure(code, providerRetryAfterMs = 1, message = "fixture failure") {
  return {
    code,
    message,
    ...(providerRetryAfterMs > 0 ? { providerRetryAfterMs } : {}),
  };
}

describe("ReConnect 重试策略", () => {
  it("apply 不依赖 settings 服务:ctx 只需要 on/effect(0.2.x 没有 ctx.settings.register)", async () => {
    const harness = createHarness({ maxDelayMs: 1000 });
    assert.deepEqual(await harness.requestError(failure("SERVER")), { kind: "retry" });
    await harness.dispose();
  });

  it("接受普通值配置(非 volatile / patch 直写),缺失字段回落到默认值", async () => {
    const harness = createHarness({ maxDelayMs: 1000 }, { volatile: false });
    assert.deepEqual(await harness.requestError(failure("PI_AI_ERROR")), { kind: "retry" });
    assert.equal(harness.session.events[0].data.mode, "always");
    await harness.dispose();
  });

  it("apply(ctx) 不带配置也能工作,使用默认值", async () => {
    const listeners = new Map();
    let cleanup;
    apply({
      on(event, listener) { listeners.set(event, listener); return () => listeners.delete(event); },
      effect(factory) { cleanup = factory(); },
    });
    const events = [];
    const result = await listeners.get("agent/request-error")({
      agent: { session: { events, append(type, data) { events.push({ type, data }); } } },
      turn: 1,
      step: 1,
      provider: "fixture",
      failure: failure("SERVER", 1),
      signal: new AbortController().signal,
    }, () => ({ kind: "next" }));
    assert.deepEqual(result, { kind: "retry" });
    assert.equal(events[0].data.mode, "always");
    await cleanup();
  });

  it("对临时错误重试并使用 durable 事件恢复计数", async () => {
    const harness = createHarness({ maxDelayMs: 1000 });

    const first = await harness.requestError(failure("SERVER"));
    assert.deepEqual(first, { kind: "retry" });
    const second = await harness.requestError(failure("RATE_LIMIT"));
    assert.deepEqual(second, { kind: "retry" });
    const third = await harness.requestError(failure("STREAM_CLOSED"));
    assert.deepEqual(third, { kind: "retry" });

    const retries = harness.session.events.filter((event) => event.type === "llm/retry");
    assert.deepEqual(retries.map((event) => event.data.retry), [1, 2, 3]);
    assert.equal(retries[0].data.policyKey, "reconnect-transient-v3");
    assert.equal(retries[0].data.retryId, retries[1].data.retryId);
    assert.equal(retries[1].data.retryId, retries[2].data.retryId);
    await harness.dispose();
  });

  it("未知错误默认无限重试,事件显示无限模式", async () => {
    const harness = createHarness({ maxDelayMs: 1000 });

    for (let retry = 1; retry <= 4; retry += 1) {
      assert.deepEqual(await harness.requestError(failure("PI_AI_ERROR")), { kind: "retry" });
    }

    const retries = harness.session.events.filter((event) => event.type === "llm/retry");
    assert.deepEqual(retries.map((event) => event.data.retry), [1, 2, 3, 4]);
    assert.equal(retries[0].data.mode, "always");
    assert.equal(Object.hasOwn(retries[0].data, "maxRetries"), false);
    await harness.dispose();
  });

  it("关闭未知错误无限重试后才使用有限上限", async () => {
    const harness = createHarness({ maxDelayMs: 1000, retryUnknown: false });

    for (let retry = 1; retry <= 3; retry += 1) {
      assert.deepEqual(await harness.requestError(failure("PI_AI_ERROR")), { kind: "retry" });
    }
    assert.deepEqual(await harness.requestError(failure("PI_AI_ERROR")), { kind: "next" });

    const retries = harness.session.events.filter((event) => event.type === "llm/retry");
    assert.deepEqual(retries.map((event) => event.data.retry), [1, 2, 3]);
    assert.equal(retries[0].data.mode, "normal");
    assert.equal(retries[0].data.maxRetries, 3);
    await harness.dispose();
  });

  it("默认无限未知策略不受 Provider normal 白名单再次阻断", async () => {
    const harness = createHarness({ maxDelayMs: 1000 });

    assert.deepEqual(await harness.requestError(failure("PI_AI_ERROR"), {
      retryPolicy: { mode: "normal", retryableCodes: ["SERVER"] },
    }), { kind: "retry" });
    assert.equal(harness.session.events[0].data.mode, "always");
    await harness.dispose();
  });

  it("未知错误上限只统计连续未知失败,临时错误会重新打开兜底窗口", async () => {
    const harness = createHarness({ maxDelayMs: 1000, retryUnknown: false });

    assert.deepEqual(await harness.requestError(failure("PI_AI_ERROR")), { kind: "retry" });
    assert.deepEqual(await harness.requestError(failure("PI_AI_ERROR")), { kind: "retry" });
    assert.deepEqual(await harness.requestError(failure("SERVER")), { kind: "retry" });
    assert.deepEqual(await harness.requestError(failure("PI_AI_ERROR")), { kind: "retry" });
    const retries = harness.session.events.filter((event) => event.type === "llm/retry");
    assert.deepEqual(retries.map((event) => event.data.retry), [1, 2, 1, 1]);
    assert.equal(retries[0].data.policyKey, retries[1].data.policyKey);
    assert.notEqual(retries[0].data.policyKey, retries[3].data.policyKey);
    assert.notEqual(retries[0].data.retryId, retries[3].data.retryId);
    await harness.dispose();
  });

  it("从旧版或无限未知策略切回有限模式时创建新的 1/N 链", async () => {
    for (const policyKey of ["reconnect-unknown-normal-v3", "reconnect-unknown-always-v3"]) {
      const harness = createHarness({ maxDelayMs: 1000, retryUnknown: false });
      harness.session.append("llm/retry", {
        retryId: "old-chain",
        turn: 1,
        step: 1,
        provider: "fixture",
        mode: policyKey.includes("always") ? "always" : "normal",
        maxRetries: 3,
        policyKey,
        retry: 3,
        delayMs: 1,
        failure: failure("PI_AI_ERROR"),
      });

      assert.deepEqual(await harness.requestError(failure("PI_AI_ERROR")), { kind: "retry" });
      const current = harness.session.events.filter((event) => event.type === "llm/retry").at(-1).data;
      assert.equal(current.retry, 1);
      assert.equal(current.mode, "normal");
      assert.equal(current.maxRetries, 3);
      assert.notEqual(current.retryId, "old-chain");
      assert.match(current.policyKey, /^reconnect-unknown-normal-v4:/);
      await harness.dispose();
    }
  });

  it("模型不存在和模型未配置错误的机器码与文本都使用无限策略", async () => {
    const cases = [
      failure("MODEL_NOT_FOUND", 1),
      failure("model_not_found", 1),
      failure("MODEL_NOT_CONFIGURED", 1),
      failure("UNKNOWN_MODEL", 1),
      failure(
        "PI_AI_ERROR",
        1,
        'OpenAI API error (404): {"message":"Model \\"gpt-5.6-luna\\" is not supported by any configured account in this group","type":"model_not_found"}',
      ),
      failure("PI_AI_ERROR", 1, 'provider response type=model_not_configured for model "gpt-5.6-luna"'),
      failure("pi_ai_error", 1, 'model "gpt-5.6-luna" is not configured for this account'),
      failure("PI_AI_ERROR", 1, 'model "gpt-5.6-luna" is not configured for this account'),
      failure("PI_AI_ERROR", 1, "no model configured for this account"),
    ];

    for (const modelFailure of cases) {
      const harness = createHarness({ maxDelayMs: 1000 });
      for (let retry = 1; retry <= 4; retry += 1) {
        assert.deepEqual(await harness.requestError(modelFailure), { kind: "retry" });
      }
      const retries = harness.session.events.filter((event) => event.type === "llm/retry");
      assert.deepEqual(retries.map((event) => event.data.retry), [1, 2, 3, 4]);
      assert.equal(new Set(retries.map((event) => event.data.mode)).size, 1);
      assert.equal(retries[0].data.mode, "always");
      assert.equal(retries[0].data.policyKey, "reconnect-model-availability-v4");
      assert.equal(retries[0].data.retryId, retries[3].data.retryId);
      assert.equal(Object.hasOwn(retries[0].data, "maxRetries"), false);
      await harness.dispose();
    }
  });

  it("Provider always 下的模型可用性错误仍由 ReConnect 无限等待", async () => {
    const harness = createHarness({ maxDelayMs: 1000 });
    const retryPolicy = { mode: "always", retryableCodes: ["PI_AI_ERROR"] };
    const modelFailure = failure(
      "PI_AI_ERROR",
      1,
      'OpenAI API error (404): {"message":"model is not configured","type":"model_not_found"}',
    );

    for (let retry = 1; retry <= 4; retry += 1) {
      assert.deepEqual(await harness.requestError(modelFailure, { retryPolicy }), { kind: "retry" });
    }
    const retries = harness.session.events.filter((event) => event.type === "llm/retry");
    assert.deepEqual(retries.map((event) => event.data.retry), [1, 2, 3, 4]);
    assert.equal(retries[0].data.mode, "always");
    assert.equal(retries[0].data.policyKey, "reconnect-model-availability-v4");
    await harness.dispose();
  });

  it("unknownMaxRetries 为零时不创建重试事件", async () => {
    const harness = createHarness({ retryUnknown: false, unknownMaxRetries: 0 });

    assert.deepEqual(await harness.requestError(failure("PI_AI_ERROR")), { kind: "next" });
    assert.equal(harness.session.events.length, 0);
    await harness.dispose();
  });

  it("永久错误和默认配额错误不重试", async () => {
    const harness = createHarness();

    for (const code of [
      "AUTH",
      "INVALID_REPLAY_STATE",
      "UNSUPPORTED_OPTION",
      "UNSUPPORTED_REASONING_EFFORT",
    ]) {
      assert.deepEqual(await harness.requestError(failure(code)), { kind: "next" });
    }
    assert.deepEqual(await harness.requestError(failure("QUOTA")), { kind: "next" });
    assert.equal(harness.session.events.length, 0);
    await harness.dispose();
  });

  it("配额开关开启后使用无限策略", async () => {
    const harness = createHarness({ retryQuota: true, maxDelayMs: 1000 });

    assert.deepEqual(await harness.requestError(failure("QUOTA")), { kind: "retry" });
    const event = harness.session.events.find((item) => item.type === "llm/retry");
    assert.equal(event.data.mode, "always");
    assert.equal(event.data.policyKey, "reconnect-quota-v3");
    await harness.dispose();
  });

  it("完整尊重 Provider Retry-After,不被本地指数上限截断", async () => {
    const harness = createHarness({ maxDelayMs: 1000 });
    const pending = harness.requestError(failure("SERVER", 120000));
    const event = harness.session.events.find((item) => item.type === "llm/retry");
    assert.equal(event.data.delayMs, 120000);
    harness.signal.abort();
    assert.deepEqual(await pending, { kind: "next" });
    await harness.dispose();
  });

  it("Provider always 策略把恢复决定交给下游插件", async () => {
    const harness = createHarness({ retryUnknown: true });

    assert.deepEqual(await harness.requestError(failure("PI_AI_ERROR"), {
      retryPolicy: { mode: "always", retryableCodes: ["PI_AI_ERROR"] },
    }), { kind: "retry" });
    assert.equal(harness.session.events[0].data.mode, "always");
    await harness.dispose();
  });

  it("工具文本不会误杀机器码明确为 SERVER 的模型错误", async () => {
    const harness = createHarness({ maxDelayMs: 1000 });

    assert.deepEqual(await harness.requestError(failure("SERVER", 0, "tool call gateway returned 502")), { kind: "retry" });
    assert.equal(harness.session.events[0].data.failure.code, "SERVER");
    await harness.dispose();
  });

  it("插件销毁会取消退避,不会留下悬挂 Promise", async () => {
    const harness = createHarness({ maxDelayMs: 1000 });
    const pending = harness.requestError(failure("SERVER", 2147483647));

    await harness.dispose();
    assert.deepEqual(await pending, { kind: "next" });
  });

  it("设置页保存(volatile 引用更新)后下一次失败立即采用新策略", async () => {
    const harness = createHarness({ maxDelayMs: 1000, retryUnknown: false, unknownMaxRetries: 1 });

    assert.deepEqual(await harness.requestError(failure("PI_AI_ERROR")), { kind: "retry" });
    assert.deepEqual(await harness.requestError(failure("PI_AI_ERROR")), { kind: "next" });
    await harness.settings.set("retryUnknown", true);
    assert.deepEqual(await harness.requestError(failure("PI_AI_ERROR")), { kind: "retry" });
    await harness.dispose();
  });
});
