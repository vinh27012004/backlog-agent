// Chọn model cho spawn (config/models.json): một thang rẻ → đắt; lần 1 theo tier Jev/luật chọn (cheap, small, strong; kể cả
// item có deadline), sau đó strong, lần cuối của deadline/PI dùng top; chỉ chọn model có trong allowedModels.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadModelsConfig, modelPlan } from '../../pack/src/decide/models.mjs';

const ENTERPRISE = ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6.1-terra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'];
const FREE = ['gpt-6-luna', 'gpt-5.6-terra', 'gpt-5.6-luna'];
const names = plan => plan.fixer.map(m => `${m.model}/${m.reasoning_effort}`);

test('config: the ladder goes from cheap to top and every role names one of its tiers', () => {
  const cfg = loadModelsConfig();
  assert.deepEqual(cfg.ladder.map(r => r.tier), ['cheap', 'small', 'strong', 'top']);
  for (const tier of Object.values(cfg.roles)) assert.ok(cfg.ladder.some(r => r.tier === tier), tier);
  for (const r of cfg.ladder) assert.ok(['low', 'medium', 'high', 'xhigh'].includes(r.effort), `${r.model} ${r.effort}`);
});

test('an easy item starts on the cheap tier, a plain one on small, and both move to strong on retries', () => {
  const easy = modelPlan({ type: 'TASK', modelTier: 'cheap', deadline: false, allowed: ENTERPRISE });
  assert.deepEqual(names(easy), ['gpt-6-luna/medium', 'gpt-6.1-sol/high', 'gpt-6.1-sol/high']);
  const plan = modelPlan({ type: 'TASK', modelTier: 'small', deadline: false, allowed: ENTERPRISE });
  assert.deepEqual(names(plan), ['gpt-6.1-terra/medium', 'gpt-6.1-sol/high', 'gpt-6.1-sol/high']);
  // Worker chụp evidence sau khi worker tier strong bàn giao code + test: tier small (nhanh ~2,5 lần mỗi lượt).
  assert.deepEqual(plan.evidence, { model: 'gpt-6.1-terra', reasoning_effort: 'medium', tier: 'small' });
  // Không có tier (triage lỗi) thì như small.
  assert.deepEqual(names(modelPlan({ type: 'TASK', modelTier: null, deadline: false, allowed: ENTERPRISE })), names(plan));
});

test('a deadline item still starts on its own tier and gets the top model on its last try', () => {
  const plan = modelPlan({ type: 'BUG', modelTier: 'cheap', deadline: true, allowed: ENTERPRISE });
  assert.deepEqual(names(plan), ['gpt-6-luna/medium', 'gpt-6.1-sol/high', 'gpt-6-astra/medium']);
});

test('a strong-tier item starts on the strong model; a PI ends on top, a CR without deadline never does', () => {
  const pi = modelPlan({ type: 'PI', modelTier: 'strong', deadline: false, allowed: ENTERPRISE });
  assert.deepEqual(pi.fixer.map(m => m.tier), ['strong', 'strong', 'strong', 'top']);
  assert.equal(names(pi)[0], 'gpt-6.1-sol/high');
  const cr = modelPlan({ type: 'CR', modelTier: 'strong', deadline: false, allowed: ENTERPRISE });
  assert.deepEqual(cr.fixer.map(m => m.tier), ['strong', 'strong', 'strong']);
});

test('a tier missing from allowedModels moves up the ladder first, then down', () => {
  const plan = modelPlan({ type: 'BUG', modelTier: 'cheap', deadline: true, allowed: ['gpt-6.1-terra', 'gpt-6-astra'] });
  assert.deepEqual(names(plan), ['gpt-6.1-terra/medium', 'gpt-6-astra/medium', 'gpt-6-astra/medium']);
  assert.equal(plan.evidence.model, 'gpt-6.1-terra');
  const free = modelPlan({ type: 'BUG', modelTier: 'small', deadline: true, allowed: FREE });
  assert.deepEqual(names(free), ['gpt-6-luna/medium', 'gpt-6-luna/medium', 'gpt-6-luna/medium']);
  assert.equal(free.evidence.model, 'gpt-6-luna');
  const noTop = modelPlan({ type: 'PI', modelTier: 'strong', deadline: false, allowed: ['gpt-6-luna', 'gpt-6.1-terra'] });
  assert.deepEqual(names(noTop), ['gpt-6.1-terra/medium', 'gpt-6.1-terra/medium', 'gpt-6.1-terra/medium', 'gpt-6.1-terra/medium']);
});

test('every pick is allowed; unknown models give null and no policy gives no plan', () => {
  for (const allowed of [ENTERPRISE, FREE, ['gpt-6.1-terra', 'gpt-6-astra'], ['gpt-6.1-sol']]) {
    for (const type of ['PI', 'BUG']) {
      for (const modelTier of ['cheap', 'small', 'strong']) {
        const plan = modelPlan({ type, modelTier, deadline: true, allowed });
        for (const m of [...plan.fixer, plan.evidence]) assert.ok(allowed.includes(m.model), m.model);
      }
    }
  }
  for (const allowed of [['gpt-6-sol'], ['gpt-test']]) {
    const odd = modelPlan({ type: 'BUG', modelTier: 'small', deadline: false, allowed });
    assert.deepEqual(odd.fixer, [null, null, null]);
    assert.equal(odd.evidence, null);
  }
  assert.equal(modelPlan({ type: 'BUG', modelTier: 'small', deadline: false, allowed: undefined }), null);
});
