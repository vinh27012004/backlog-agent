// Model cụ thể cho từng lần spawn (config/models.json): mỗi tier là danh sách ưu tiên, lấy model đầu tiên có trong
// allowedModels của MTM_MODEL_POLICY_V1. Không model nào khớp thì trả null: root bỏ trống model, subagent dùng model root.
// Thang fixer: lần 1 rẻ (small), item có deadline hoặc tier strong thì strong ngay; từ lần 2 strong; lần cuối của item
// có deadline hoặc PI thì top. Tính lại mỗi lần gọi vì operator có thể đổi allowedModels khi Stop/Resume.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export function loadModelsConfig() {
  return JSON.parse(readFileSync(join(here, '..', 'config', 'models.json'), 'utf8'));
}

export function pickModel(tier, allowed, cfg = loadModelsConfig()) {
  const hit = (cfg.tiers[tier] ?? []).find(c => allowed.includes(c.model));
  return hit ? { model: hit.model, reasoning_effort: hit.effort, tier } : null;
}

// fixer[n-1] cho lần thử n (lần sau cuối dùng phần tử cuối); số phần tử = số lần thử tối đa (PI 4, còn lại 3).
export function modelPlan({ type, modelTier, deadline, allowed, cfg = loadModelsConfig() }) {
  if (!allowed?.length) return null;
  const attempts = type === 'PI' ? 4 : 3;
  const tiers = Array.from({ length: attempts }, (_, i) => (i === 0 && modelTier !== 'strong' && !deadline ? 'small' : 'strong'));
  if (deadline || type === 'PI') tiers[attempts - 1] = 'top';
  return {
    fixer: tiers.map(t => pickModel(t, allowed, cfg)),
    reviewer: pickModel(cfg.roles.reviewer, allowed, cfg),
    piHypothesis: pickModel(cfg.roles.piHypothesis, allowed, cfg),
  };
}
