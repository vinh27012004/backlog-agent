// Chọn model cho spawn (config/models.json): lần 1 rẻ, sau đó mạnh hơn, deadline bắt đầu mạnh, lần cuối của deadline/PI dùng top;
// chỉ chọn model có trong allowedModels.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadModelsConfig, modelPlan } from '../../pack/src/models.mjs';

const ENTERPRISE = ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6.1-terra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'];
const FREE = ['gpt-6-luna', 'gpt-5.6-terra', 'gpt-5.6-luna'];
const names = plan => plan.fixer.map(m => `${m.model}/${m.reasoning_effort}`);

test('a plain item starts cheap and moves to the strong tier on retries', () => {
  const plan = modelPlan({ type: 'TASK', modelTier: 'small', deadline: false, allowed: ENTERPRISE });
  assert.deepEqual(names(plan), ['gpt-6.1-terra/medium', 'gpt-6.1-sol/high', 'gpt-6.1-sol/high']);
  assert.deepEqual(plan.reviewer, { model: 'gpt-6.1-sol', reasoning_effort: 'medium', tier: 'review' });
  // Checker giả thuyết chỉ chạy khi PI đã kẹt: dùng tier strong.
  assert.deepEqual(plan.piHypothesis, { model: 'gpt-6.1-sol', reasoning_effort: 'high', tier: 'strong' });
});

test('a deadline item starts strong and gets the top model on its last try', () => {
  const plan = modelPlan({ type: 'BUG', modelTier: 'small', deadline: true, allowed: ENTERPRISE });
  assert.deepEqual(names(plan), ['gpt-6.1-sol/high', 'gpt-6.1-sol/high', 'gpt-6-astra/high']);
});

test('a PI has four tries, strong first, top last; a CR without deadline never reaches top', () => {
  const pi = modelPlan({ type: 'PI', modelTier: 'strong', deadline: false, allowed: ENTERPRISE });
  assert.deepEqual(pi.fixer.map(m => m.tier), ['strong', 'strong', 'strong', 'top']);
  const cr = modelPlan({ type: 'CR', modelTier: 'strong', deadline: false, allowed: ENTERPRISE });
  assert.deepEqual(cr.fixer.map(m => m.tier), ['strong', 'strong', 'strong']);
});

test('on the free account each tier falls back to an allowed model', () => {
  const plan = modelPlan({ type: 'BUG', modelTier: 'small', deadline: true, allowed: FREE });
  assert.deepEqual(names(plan), ['gpt-5.6-terra/high', 'gpt-5.6-terra/high', 'gpt-5.6-terra/high']);
  const plain = modelPlan({ type: 'TASK', modelTier: 'small', deadline: false, allowed: FREE });
  assert.equal(plain.fixer[0].model, 'gpt-6-luna');
  assert.equal(plain.reviewer.model, 'gpt-5.6-terra');
});

test('every pick is allowed; unknown models give null and no policy gives no plan', () => {
  for (const allowed of [ENTERPRISE, FREE, ['gpt-6-luna']]) {
    for (const type of ['PI', 'BUG']) {
      const plan = modelPlan({ type, modelTier: 'small', deadline: true, allowed });
      for (const m of [...plan.fixer, plan.reviewer, plan.piHypothesis]) assert.ok(allowed.includes(m.model), m.model);
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
