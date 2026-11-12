// Model cụ thể cho từng lần spawn (config/models.json): một thang model xếp từ rẻ đến đắt, mỗi bậc là một tier. Bậc
// không có trong allowedModels của MTM_MODEL_POLICY_V1 thì lên bậc gần nhất phía trên, hết thì xuống bậc gần nhất phía
// dưới. Không bậc nào khớp thì trả null: root bỏ trống model, subagent dùng model root.
// Thang fixer: lần 1 theo tier Jev/luật chọn (cheap cho item easy, small, strong cho PI/CR/hard; kể cả item có
// deadline); từ lần 2 strong (ZVUYZ41V: 6-luna lần 1 trên item khó tốn 7–15 phút rồi vẫn phải lên 6.1-sol); lần cuối
// của item có deadline hoặc PI thì top. Tính lại mỗi lần gọi vì operator có thể đổi allowedModels khi Stop/Resume.
// `fixerTiers` ({"PI": "strong", "default": "cheap"}) thay cả thang: mọi lần thử của loại item đó dùng đúng một tier,
// dùng để thử model (12/11: mọi item luna, chỉ PI 6.1-sol). Ghi đè cục bộ ở team-sdlc-pack/local/models.json như jev.json.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const TIERS = ['cheap', 'small', 'strong', 'top'];

export function loadModelsConfig(localDir = null) {
  const base = JSON.parse(readFileSync(join(here, '..', '..', 'config', 'models.json'), 'utf8'));
  let local = {};
  if (localDir && existsSync(join(localDir, 'models.json'))) {
    try { local = JSON.parse(readFileSync(join(localDir, 'models.json'), 'utf8')); } catch { local = {}; }
  }
  const cfg = { ...base };
  if (Array.isArray(local.ladder) && local.ladder.length) cfg.ladder = local.ladder;
  if (local.fixerTiers && typeof local.fixerTiers === 'object') cfg.fixerTiers = local.fixerTiers;
  return cfg;
}

export function pickModel(tier, allowed, cfg = loadModelsConfig()) {
  const at = cfg.ladder.findIndex(r => r.tier === tier);
  if (at < 0) return null;
  const order = [...cfg.ladder.slice(at), ...cfg.ladder.slice(0, at).reverse()];
  const hit = order.find(r => allowed.includes(r.model));
  return hit ? { model: hit.model, reasoning_effort: hit.effort, tier } : null;
}

// Tier cố định cho loại item theo `fixerTiers` (null khi không đặt hay tier lạ).
export function fixedTier(type, cfg) {
  const map = cfg?.fixerTiers;
  if (!map || typeof map !== 'object') return null;
  const tier = map[String(type ?? '').toUpperCase()] ?? map.default;
  return TIERS.includes(tier) ? tier : null;
}

// fixer[n-1] cho lần thử n (lần sau cuối dùng phần tử cuối); số phần tử = số lần thử tối đa (PI 4, còn lại 3).
export function modelPlan({ type, modelTier, deadline, allowed, cfg = loadModelsConfig() }) {
  if (!allowed?.length) return null;
  const attempts = type === 'PI' ? 4 : 3;
  const fixed = fixedTier(type, cfg);
  if (fixed) return { fixer: Array.from({ length: attempts }, () => pickModel(fixed, allowed, cfg)) };
  const first = ['cheap', 'small', 'strong'].includes(modelTier) ? modelTier : 'small';
  const tiers = Array.from({ length: attempts }, (_, i) => (i > 0 ? 'strong' : first));
  if (deadline || type === 'PI') tiers[attempts - 1] = 'top';
  return { fixer: tiers.map(t => pickModel(t, allowed, cfg)) };
}
