// Chọn model cho spawn (config/models.json): lần 1 theo tier (small rẻ kể cả item có deadline, strong mạnh ngay), sau đó mạnh hơn, lần cuối của deadline/PI dùng top;
// chỉ chọn model có trong allowedModels.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadModelsConfig, modelPlan } from '../../pack/src/models.mjs';

const ENTERPRISE = ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6.1-terra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'];
const FREE = ['gpt-6-luna', 'gpt-5.6-terra', 'gpt-5.6-luna'];
const names = plan => plan.fixer.map(m => `${m.model}/${m.reasoning_effort}`);

test('a plain item starts cheap and moves to the strong tier on retries', () => {
  const plan = modelPlan({ type: 'TASK', modelTier: 'small', deadline: false, allowed: ENTERPRISE });
  assert.deepEqual(names(plan), ['gpt-6-sol/medium', 'gpt-6.1-sol/high', 'gpt-6.1-sol/high']);
  assert.deepEqual(plan.reviewer, { model: 'gpt-6-sol', reasoning_effort: 'high', tier: 'review' });
  // Checker giả thuyết chỉ chạy khi PI đã kẹt: dùng tier strong.
  assert.deepEqual(plan.piHypothesis, { model: 'gpt-6.1-sol', reasoning_effort: 'high', tier: 'strong' });
  // Verifier chỉ chạy gate và đối chiếu MVS: tier small.
  assert.deepEqual(plan.verifier, { model: 'gpt-6-sol', reasoning_effort: 'medium', tier: 'small' });
});

test('a deadline item still starts cheap and gets the top model on its last try', () => {
  const plan = modelPlan({ type: 'BUG', modelTier: 'small', deadline: true, allowed: ENTERPRISE });
  assert.deepEqual(names(plan), ['gpt-6-sol/medium', 'gpt-6.1-sol/high', 'gpt-6-astra/high']);
});

test('a strong-tier item starts on the strong model; a PI ends on top, a CR without deadline never does', () => {
  const pi = modelPlan({ type: 'PI', modelTier: 'strong', deadline: false, allowed: ENTERPRISE });
  assert.deepEqual(pi.fixer.map(m => m.tier), ['strong', 'strong', 'strong', 'top']);
  assert.equal(names(pi)[0], 'gpt-6.1-sol/high');
  const cr = modelPlan({ type: 'CR', modelTier: 'strong', deadline: false, allowed: ENTERPRISE });
  assert.deepEqual(cr.fixer.map(m => m.tier), ['strong', 'strong', 'strong']);
});

test('on the free account each tier falls back to an allowed model', () => {
  const plan = modelPlan({ type: 'BUG', modelTier: 'small', deadline: true, allowed: FREE });
  assert.deepEqual(names(plan), ['gpt-6-luna/medium', 'gpt-5.6-terra/high', 'gpt-5.6-terra/high']);
  const plain = modelPlan({ type: 'TASK', modelTier: 'small', deadline: false, allowed: FREE });
  assert.equal(plain.fixer[0].model, 'gpt-6-luna');
  assert.equal(plain.reviewer.model, 'gpt-6-luna');
});

test('every pick is allowed; unknown models give null and no policy gives no plan', () => {
  for (const allowed of [ENTERPRISE, FREE, ['gpt-6-luna']]) {
    for (const type of ['PI', 'BUG']) {
      const plan = modelPlan({ type, modelTier: 'small', deadline: true, allowed });
      for (const m of [...plan.fixer, plan.reviewer, plan.piHypothesis, plan.verifier]) assert.ok(allowed.includes(m.model), m.model);
    }
  }
  const odd = modelPlan({ type: 'BUG', modelTier: 'small', deadline: false, allowed: ['gpt-test'] });
  assert.deepEqual(odd.fixer, [null, null, null]);
  assert.equal(odd.reviewer, null);
  assert.equal(modelPlan({ type: 'BUG', modelTier: 'small', deadline: false, allowed: undefined }), null);
});

test('config: every role names a tier and efforts are ones Codex accepts', () => {
  const cfg = loadModelsConfig();
  for (const tier of Object.values(cfg.roles)) assert.ok(cfg.tiers[tier], tier);
  for (const list of Object.values(cfg.tiers)) {
    for (const c of list) assert.ok(['low', 'medium', 'high', 'xhigh'].includes(c.effort), `${c.model} ${c.effort}`);
  }
});
