"use strict";
/**
 * Session-scoped `codegraph_explore` call state (CG-17).
 *
 * What it holds: for ONE MCP session, per project it queried, what explore has
 * already returned — the files, the line ranges of source inside them, the bytes
 * they cost, and where in the session each call fell. Nothing else in the server
 * knows this today: every explore call is answered as if it were the first one,
 * which is why a 4th call happily re-serves the same spine it already sent
 * (#1500) and why the tier's call budget can only be *asked* for rather than
 * enforced. This module is the record those two behaviours are built on
 * (CG-18 cross-call dedup, CG-19 budget decay). It changes no response itself.
 *
 * Four constraints shape the design, all of them from how the daemon actually
 * runs:
 *
 *   1. **Per session, never persisted.** One instance is owned by an
 *      {@link ../mcp/session.MCPSession} and dies with the socket. A new agent
 *      session starts clean — dedup across sessions would suppress source the
 *      new agent has never seen.
 *   2. **Per project inside the session.** A session can query several projects
 *      by `projectPath`, so state is keyed by the RESOLVED project root
 *      (`cg.getProjectRoot()`), not by whatever path the agent typed.
 *   3. **Bounded.** A long-lived session must not grow without limit, so
 *      everything is capped — see {@link EXPLORE_SESSION_LIMITS}. Eviction drops
 *      DETAIL only: `callCount` and `responseBytes` keep counting past it, since
 *      decay (CG-19) reads the count and must not be reset by its own bound.
 *   4. **Daemon-safe.** The daemon shares ONE {@link ../mcp/tools.ToolHandler}
 *      (and a pool of worker threads) across every connected session, so this
 *      state can live neither on the handler nor in a worker. It lives on the
 *      session; the handler is handed it per call, and the record of what a call
 *      emitted travels back on the {@link ToolResult} so it can be recorded on
 *      the main thread whether dispatch ran in-process or on a worker.
 *
 * Over- vs under-reporting: where a bound forces a choice, this module keeps
 * FEWER ranges than were emitted, never more. A consumer that under-knows
 * re-serves something the agent already has (wasteful); one that over-knows
 * withholds source the agent never saw (a Read — the failure this whole area
 * exists to prevent).
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.ExploreSessionState = exports.EXPLORE_SESSION_LIMITS = exports.EXPLORE_SESSION_VIEW_ARG = exports.EXPLORE_EMISSION_KEY = void 0;
exports.exploreProjectKey = exploreProjectKey;
exports.coalesceRanges = coalesceRanges;
exports.rangesCover = rangesCover;
exports.readExploreSessionView = readExploreSessionView;
exports.viewForProject = viewForProject;
const path = __importStar(require("path"));
/**
 * Property on a {@link ../mcp/tools.ToolResult} carrying what an explore call
 * emitted. INTERNAL: `ToolHandler.execute` records it and deletes it before the
 * result reaches the wire, so the agent-facing response is unchanged. It is a
 * plain-object property (not a Symbol) on purpose — it has to survive the
 * structured clone back from a query-pool worker.
 */
exports.EXPLORE_EMISSION_KEY = '_cgExploreEmission';
/**
 * Argument key carrying this session's prior-call view INTO a tool call. Same
 * reasoning as {@link EXPLORE_EMISSION_KEY}: it crosses the worker boundary, so
 * it must be a serializable property on the args object.
 */
exports.EXPLORE_SESSION_VIEW_ARG = '_cgExploreSession';
/**
 * Memory bounds. Every one of them caps DETAIL; none caps the counters that
 * CG-19's decay reads.
 *
 * Sized against how sessions actually behave: an agent explores one project
 * (occasionally a second in a monorepo) and the tier call budget is 1–5, so the
 * retained window covers a whole realistic session and the caps only bite on
 * pathological ones.
 */
exports.EXPLORE_SESSION_LIMITS = {
    /** Distinct projects kept per session; least-recently-used evicted first. */
    MAX_PROJECTS: 4,
    /** Call records kept per project (oldest dropped; `callCount` keeps counting). */
    MAX_CALLS_RETAINED: 8,
    /** Files kept per call — the ones that got the most source. */
    MAX_FILES_PER_CALL: 24,
    /** Line ranges kept per file after coalescing — the largest spans. */
    MAX_RANGES_PER_FILE: 24,
    /** Most-recent calls per project included in {@link ExploreSessionView}. */
    MAX_VIEW_CALLS: 4,
};
/**
 * Key a project root is filed under. Resolved so `/repo` and `/repo/` agree;
 * case-folded on the two platforms whose filesystems are case-insensitive, so a
 * drive-letter or capitalization difference doesn't split one project in two.
 */
function exploreProjectKey(projectRoot) {
    const resolved = path.resolve(projectRoot);
    return process.platform === 'win32' || process.platform === 'darwin'
        ? resolved.toLowerCase()
        : resolved;
}
/**
 * Merge overlapping / adjacent spans into the smallest equivalent set, then cap
 * it. Adjacency (`next.start <= cur.end + 1`) counts as overlap: two ranges that
 * touch describe one contiguous block of emitted source.
 *
 * When the cap bites, the LARGEST spans are kept and the result is re-sorted by
 * line so the set still reads top-to-bottom — dropping small fragments loses the
 * least information, and under-reporting is the safe direction (see the module
 * header).
 */
function coalesceRanges(ranges, max = exports.EXPLORE_SESSION_LIMITS.MAX_RANGES_PER_FILE) {
    const valid = ranges
        .filter((r) => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end >= r.start && r.start >= 1)
        .map((r) => ({ start: Math.floor(r.start), end: Math.floor(r.end) }))
        .sort((a, b) => a.start - b.start || a.end - b.end);
    const merged = [];
    for (const r of valid) {
        const last = merged[merged.length - 1];
        if (last && r.start <= last.end + 1)
            last.end = Math.max(last.end, r.end);
        else
            merged.push({ ...r });
    }
    if (merged.length <= max)
        return { ranges: merged, truncated: false };
    const kept = [...merged]
        .sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start)
        .slice(0, max)
        .sort((a, b) => a.start - b.start);
    return { ranges: kept, truncated: true };
}
/** Whether a line falls inside any of the (sorted, coalesced) ranges. */
function rangesCover(ranges, line) {
    return ranges.some((r) => line >= r.start && line <= r.end);
}
/**
 * One MCP session's explore history. Created per session, thrown away with it.
 *
 * Not thread-shared and not a singleton: two sessions on the same daemon own two
 * instances and can never observe each other's calls. Every method is total —
 * malformed input is normalized away rather than thrown, because this sits on
 * the tool-call path and a bookkeeping bug must never fail an explore.
 */
class ExploreSessionState {
    /** Insertion-ordered; a touched project is re-inserted, so the head is the LRU. */
    projects = new Map();
    /**
     * File an emission. Returns the record as stored (with its session call
     * index), or `null` if the emission was unusable.
     */
    record(emission) {
        if (!emission || typeof emission.projectRoot !== 'string' || !emission.projectRoot)
            return null;
        const key = exploreProjectKey(emission.projectRoot);
        const state = this.touch(key, emission.projectRoot);
        state.callCount += 1;
        state.responseBytes += Math.max(0, emission.responseBytes || 0);
        const record = {
            index: state.callCount,
            projectRoot: emission.projectRoot,
            query: typeof emission.query === 'string' ? emission.query : '',
            files: this.boundFiles(emission.files),
            sourceBytes: Math.max(0, emission.sourceBytes || 0),
            responseBytes: Math.max(0, emission.responseBytes || 0),
        };
        state.calls.push(record);
        if (state.calls.length > exports.EXPLORE_SESSION_LIMITS.MAX_CALLS_RETAINED) {
            state.calls.splice(0, state.calls.length - exports.EXPLORE_SESSION_LIMITS.MAX_CALLS_RETAINED);
        }
        return record;
    }
    /** Full state for one project, or `null` if it was never queried this session. */
    forProject(projectRoot) {
        const state = this.projects.get(exploreProjectKey(projectRoot));
        return state ? cloneProject(state) : null;
    }
    /** Explore calls made this session against a project (including evicted ones). */
    callCount(projectRoot) {
        return this.projects.get(exploreProjectKey(projectRoot))?.callCount ?? 0;
    }
    /** Every project this session has queried, least-recently-used first. */
    snapshot() {
        return [...this.projects.values()].map(cloneProject);
    }
    /**
     * The bounded view passed INTO a tool call. Trimmed to the most recent
     * {@link EXPLORE_SESSION_LIMITS.MAX_VIEW_CALLS} calls per project: it crosses a
     * worker boundary on every explore, so it carries what a dedup/decay decision
     * needs and not the whole history.
     */
    view() {
        return {
            projects: [...this.projects.values()].map((state) => ({
                projectRoot: state.projectRoot,
                callCount: state.callCount,
                responseBytes: state.responseBytes,
                calls: state.calls
                    .slice(-exports.EXPLORE_SESSION_LIMITS.MAX_VIEW_CALLS)
                    .map((c) => ({ ...c, files: c.files.map((f) => ({ ...f, ranges: [...f.ranges] })) })),
            })),
        };
    }
    /** Drop everything. Used by tests; a real session just goes away instead. */
    clear() {
        this.projects.clear();
    }
    /**
     * Fetch a project's state, creating it if new, and mark it most-recently-used.
     * Evicts the LRU project past the bound — dropping a project entirely (rather
     * than its detail) is right here: a session that has moved on to four other
     * repos is not about to re-ask the first one.
     */
    touch(key, projectRoot) {
        const existing = this.projects.get(key);
        if (existing) {
            this.projects.delete(key);
            this.projects.set(key, existing);
            return existing;
        }
        const created = { projectRoot, callCount: 0, responseBytes: 0, calls: [] };
        this.projects.set(key, created);
        while (this.projects.size > exports.EXPLORE_SESSION_LIMITS.MAX_PROJECTS) {
            const lru = this.projects.keys().next().value;
            if (lru === undefined)
                break;
            this.projects.delete(lru);
        }
        return created;
    }
    /**
     * Normalize + bound one call's files: coalesce each file's ranges, then keep
     * the files that got the most source. A call that renders more files than the
     * bound has already spread its envelope thin, so the tail files carry the
     * least — and losing them costs the least.
     */
    boundFiles(files) {
        if (!Array.isArray(files) || files.length === 0)
            return [];
        const normalized = files
            .filter((f) => f && typeof f.path === 'string' && f.path.length > 0)
            .map((f) => {
            const { ranges, truncated } = coalesceRanges(f.ranges ?? []);
            const out = { path: f.path, ranges, bytes: Math.max(0, f.bytes || 0) };
            if (typeof f.fingerprint === 'string' && f.fingerprint)
                out.fingerprint = f.fingerprint;
            if (truncated)
                out.rangesTruncated = true;
            return out;
        });
        if (normalized.length <= exports.EXPLORE_SESSION_LIMITS.MAX_FILES_PER_CALL)
            return normalized;
        return [...normalized]
            .sort((a, b) => b.bytes - a.bytes)
            .slice(0, exports.EXPLORE_SESSION_LIMITS.MAX_FILES_PER_CALL);
    }
}
exports.ExploreSessionState = ExploreSessionState;
function cloneProject(state) {
    return {
        projectRoot: state.projectRoot,
        callCount: state.callCount,
        responseBytes: state.responseBytes,
        calls: state.calls.map((c) => ({ ...c, files: c.files.map((f) => ({ ...f, ranges: [...f.ranges] })) })),
    };
}
/**
 * Read the session view a caller injected into tool args, if any. Defensive:
 * the key is internal, but the args object comes off the wire, so a client that
 * spells it itself gets ignored rather than trusted into a crash.
 */
function readExploreSessionView(args) {
    const raw = args?.[exports.EXPLORE_SESSION_VIEW_ARG];
    if (!raw || typeof raw !== 'object')
        return null;
    const projects = raw.projects;
    if (!Array.isArray(projects))
        return null;
    return { projects: projects.filter((p) => p && typeof p.projectRoot === 'string') };
}
/**
 * This session's prior state for one project, from an injected view.
 *
 * `null` means NOBODY IS TRACKING (no view was injected — the CLI, a bare
 * handler). A view that simply hasn't seen this project yet returns an EMPTY
 * state, not null: the distinction matters to consumers, since "first call of a
 * tracked session" and "untracked" are different situations.
 */
function viewForProject(view, projectRoot) {
    if (!view)
        return null;
    const key = exploreProjectKey(projectRoot);
    return view.projects.find((p) => exploreProjectKey(p.projectRoot) === key)
        ?? { projectRoot, callCount: 0, responseBytes: 0, calls: [] };
}
//# sourceMappingURL=explore-session-state.js.map