import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
const TRANSCRIPT_ITEMS = 200, TRANSCRIPT_TEXT_BYTES = 256 * 1024;

/** Keeps the newest transcript entries that fit one task's share of a dashboard upload. */
export function boundTranscriptItems(items, maxItems = TRANSCRIPT_ITEMS, maxBytes = TRANSCRIPT_TEXT_BYTES) {
  const kept = []; let bytes = 0;
  for (let index = items.length - 1; index >= 0 && kept.length < maxItems; index--) {
    // The whole entry counts: `detail` holds a command's input and output and outweighs `text`.
    bytes += Buffer.byteLength(JSON.stringify(items[index] ?? null));
    if (bytes > maxBytes) break;
    kept.push(items[index]);
  }
  return kept.reverse();
}

const transcriptItemKey = (type, item) => `${type}|${JSON.stringify(item?.detail?.input ?? null)}`;

/**
 * Removes upload entries that say nothing new: a started entry whose completed entry follows with
 * the same input, and reasoning markers, which carry no text. A running item stays visible.
 */
export function compactTranscriptItems(items) {
  const completed = new Map(), kept = [];
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index], type = String(item?.type ?? '');
    if (type.endsWith(':REASONING')) continue;
    if (type.startsWith('ITEM.COMPLETED:')) {
      const key = transcriptItemKey(type.slice('ITEM.COMPLETED:'.length), item);
      completed.set(key, (completed.get(key) ?? 0) + 1);
    } else if (type.startsWith('ITEM.STARTED:')) {
      const key = transcriptItemKey(type.slice('ITEM.STARTED:'.length), item), count = completed.get(key) ?? 0;
      if (count > 0) { completed.set(key, count - 1); continue; }
    }
    kept.push(item);
  }
  return kept.reverse();
}

// These change on every status poll or second of work, so they alone do not make a snapshot new.
const VOLATILE_FIELDS = new Set(['observedAt', 'requestId', 'observedActiveSeconds']);
const ENDED_STATUSES = new Set(['FINISHED', 'CANCELLED']), ACCEPTING_STATUSES = new Set(['PREPARING', 'IN_PROGRESS']);

export function dashboardFingerprint(dashboard) {
  return createHash('sha256').update(JSON.stringify(dashboard,
    (key, value) => VOLATILE_FIELDS.has(key) ? undefined : value)).digest('hex');
}

export function createDashboardStreamingClient({ session, roundId, getSnapshot,
  fetchImpl = globalThis.fetch, intervalMs = 1_000, minPushIntervalMs = 15_000, heartbeatMs = 60_000, maxRetryMs = 300_000,
  matchStatus = () => null, endpointPath = '/api/v1/game-player/dashboardSnapshot', now = Date.now, onStatus = () => {},
  isPaused = () => false }) {
  if (!session || !id(session.matchId) || !id(session.teamId) || !id(session.playerSessionId) ||
      typeof session.gameMasterPlayerSecret !== 'string' || !session.gameMasterPlayerSecret ||
      !id(roundId) || typeof getSnapshot !== 'function' || typeof fetchImpl !== 'function' ||
      !Number.isSafeInteger(intervalMs) || intervalMs < 100 || !Number.isSafeInteger(minPushIntervalMs) ||
      minPushIntervalMs < 0 || typeof now !== 'function' || typeof onStatus !== 'function') throw Error('INVALID_DASHBOARD_STREAMING_CONFIG');
  const endpoint = new URL(endpointPath, session.gameMasterApiUrl);
  let timer = null, stopped = false, sending = false, lastHash = null, revision = 0, lastBuildAt = null;
  let lastFingerprint = null, lastPushAt = null, failures = 0, retryAt = null, rejected = null;
  let state = { enabled: true, status: 'STARTING', lastAttemptAt: null, lastSuccessAt: null,
    lastHttpStatus: null, revision: 0, lastHash: null, lastError: null,
    lastSnapshotBytes: null, lastUploadBytes: null };
  const publish = change => { state = Object.freeze({ ...state, ...change });
    try { onStatus(state); } catch { /* diagnostics cannot interrupt streaming */ } };
  const scheduleRetry = () => { failures += 1; retryAt = now() + Math.min(maxRetryMs, minPushIntervalMs * 2 ** (failures - 1)); };
  const poll = async () => {
    // Building a snapshot reads transcripts, so it follows the push limit instead of the tick. Push
    // only new content, and at most once per minPushIntervalMs (failed attempts included) so a busy
    // round cannot flood the Game Master with snapshots. An idle round still pushes once per
    // heartbeatMs so viewers see fresh poll times.
    if (stopped || sending || (lastBuildAt !== null && now() - lastBuildAt < minPushIntervalMs)) return;
    // A rejected or failed upload would resend the whole snapshot, so it waits instead. An ended
    // match never accepts again. A rejected one resumes when its status returns to an accepting
    // one, or at the slow retry in case Player's status lags the Game Master's.
    const status = matchStatus();
    if (ENDED_STATUSES.has(status) || rejected?.ended) {
      if (state.status !== 'MATCH_ENDED') publish({ status: 'MATCH_ENDED', lastError: null });
      return;
    }
    if (rejected && status !== rejected.status && ACCEPTING_STATUSES.has(status)) { rejected = null; retryAt = null; }
    if (retryAt !== null && now() < retryAt) return;
    if (isPaused()) { if (state.status !== 'PAUSED_MEMORY') publish({ status: 'PAUSED_MEMORY' }); return; }
    sending = true; lastBuildAt = now();
    try {
      const dashboard = await getSnapshot();
      const serialized = JSON.stringify(dashboard);
      const contentHash = `sha256:${createHash('sha256').update(serialized).digest('hex')}`;
      if (contentHash === lastHash) return;
      const fingerprint = dashboardFingerprint(dashboard);
      if (fingerprint === lastFingerprint && now() - lastPushAt < heartbeatMs) return;
      const body = { schemaVersion: 1, type: 'ROUND_DASHBOARD_SNAPSHOT', matchId: session.matchId,
        roundId, playerSessionId: session.playerSessionId, teamId: session.teamId,
        generatedAt: new Date().toISOString(), contentHash, dashboard };
      const requestBody = Buffer.from(JSON.stringify(body));
      const compressedBody = gzipSync(requestBody);
      const attemptedAt = new Date().toISOString();
      publish({ status: revision ? 'UPDATING' : 'CONNECTING', lastAttemptAt: attemptedAt, lastError: null,
        lastSnapshotBytes: Buffer.byteLength(serialized), lastUploadBytes: compressedBody.byteLength });
      const response = await fetchImpl(endpoint, { method: 'POST', redirect: 'manual', cache: 'no-store',
        headers: { authorization: `Bearer ${session.gameMasterPlayerSecret}`,
          'content-type': 'application/json', 'content-encoding': 'gzip', accept: 'application/json' },
        body: compressedBody, signal: AbortSignal.timeout(15_000) });
      if (!response.ok) {
        const refusal = response.status === 409 ? await response.json().catch(() => null) : null;
        if (refusal?.error?.code === 'MATCH_NOT_ACCEPTING_DASHBOARD') {
          rejected = { status, ended: ENDED_STATUSES.has(refusal.error.details?.status) };
          retryAt = now() + maxRetryMs;
          publish({ status: rejected.ended ? 'MATCH_ENDED' : 'WAITING_FOR_MATCH', lastHttpStatus: 409, lastError: null });
          return;
        }
        scheduleRetry();
        publish({ status: 'RETRYING', lastHttpStatus: response.status, lastError: `HTTP_${response.status}` }); return;
      }
      rejected = null; failures = 0; retryAt = null;
      lastHash = contentHash; lastFingerprint = fingerprint; lastPushAt = now(); revision += 1;
      publish({ status: 'CONNECTED', lastSuccessAt: new Date().toISOString(),
        lastHttpStatus: response.status, revision, lastHash, lastError: null });
    } catch { scheduleRetry(); publish({ status: 'RETRYING', lastHttpStatus: null, lastError: 'STREAMING_UNAVAILABLE' }); }
    finally { sending = false; }
  };
  timer = setInterval(() => { void poll(); }, intervalMs); timer.unref?.(); void poll();
  return Object.freeze({ poll, status: () => state,
    close: () => { stopped = true; if (timer) clearInterval(timer); timer = null;
      publish({ status: 'STOPPED' }); } });
}
