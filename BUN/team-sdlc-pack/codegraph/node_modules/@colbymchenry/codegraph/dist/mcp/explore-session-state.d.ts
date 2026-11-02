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
/**
 * Property on a {@link ../mcp/tools.ToolResult} carrying what an explore call
 * emitted. INTERNAL: `ToolHandler.execute` records it and deletes it before the
 * result reaches the wire, so the agent-facing response is unchanged. It is a
 * plain-object property (not a Symbol) on purpose — it has to survive the
 * structured clone back from a query-pool worker.
 */
export declare const EXPLORE_EMISSION_KEY = "_cgExploreEmission";
/**
 * Argument key carrying this session's prior-call view INTO a tool call. Same
 * reasoning as {@link EXPLORE_EMISSION_KEY}: it crosses the worker boundary, so
 * it must be a serializable property on the args object.
 */
export declare const EXPLORE_SESSION_VIEW_ARG = "_cgExploreSession";
/** An inclusive 1-based line span of a file that was emitted. */
export interface ExploreLineRange {
    start: number;
    end: number;
}
/** What one call emitted for one file. */
export interface ExploreFileEmission {
    /** Project-relative path, exactly as the response's file header spells it. */
    path: string;
    /** Coalesced line spans whose source was in the response. */
    ranges: ExploreLineRange[];
    /** Source chars emitted for this file (excludes headers / fences). */
    bytes: number;
    /**
     * Identity of the bytes those ranges were sliced from (CG-18). Cross-call
     * dedup withholds a span only when the file still hashes to this, so an edit
     * between two calls re-serves instead of pointing at source the agent holds a
     * now-wrong copy of. Absent = unprovable, which dedup treats as "re-serve".
     */
    fingerprint?: string;
    /** Set when ranges were dropped to stay under the per-file bound. */
    rangesTruncated?: boolean;
}
/** What one explore call emitted, as reported by the handler. */
export interface ExploreEmission {
    /** Resolved project root — the key state is filed under. */
    projectRoot: string;
    /** Normalized query text (post `normalizeQuerySpelling`). */
    query: string;
    files: ExploreFileEmission[];
    /** Source chars across all files. */
    sourceBytes: number;
    /** Total chars of the response the agent received. */
    responseBytes: number;
}
/** A recorded call: an emission plus where it fell in the session. */
export interface ExploreCallRecord extends ExploreEmission {
    /** 1-based call index within this session FOR THIS PROJECT. Survives eviction. */
    index: number;
}
/** Everything the session knows about one project. */
export interface ExploreProjectState {
    projectRoot: string;
    /** Explore calls made this session against this project, including evicted ones. */
    callCount: number;
    /** Response chars across every call, including evicted ones. */
    responseBytes: number;
    /** Retained call records, oldest first. Bounded — may omit early calls. */
    calls: ExploreCallRecord[];
}
/**
 * The bounded, serializable read-view handed to a tool call. Deliberately
 * smaller than the full state: only the most recent calls carry their ranges,
 * because that is what a dedup/decay decision reads and the whole thing is
 * structured-cloned to a worker on every call.
 */
export interface ExploreSessionView {
    projects: ExploreProjectState[];
}
/**
 * Memory bounds. Every one of them caps DETAIL; none caps the counters that
 * CG-19's decay reads.
 *
 * Sized against how sessions actually behave: an agent explores one project
 * (occasionally a second in a monorepo) and the tier call budget is 1–5, so the
 * retained window covers a whole realistic session and the caps only bite on
 * pathological ones.
 */
export declare const EXPLORE_SESSION_LIMITS: {
    /** Distinct projects kept per session; least-recently-used evicted first. */
    readonly MAX_PROJECTS: 4;
    /** Call records kept per project (oldest dropped; `callCount` keeps counting). */
    readonly MAX_CALLS_RETAINED: 8;
    /** Files kept per call — the ones that got the most source. */
    readonly MAX_FILES_PER_CALL: 24;
    /** Line ranges kept per file after coalescing — the largest spans. */
    readonly MAX_RANGES_PER_FILE: 24;
    /** Most-recent calls per project included in {@link ExploreSessionView}. */
    readonly MAX_VIEW_CALLS: 4;
};
/**
 * Key a project root is filed under. Resolved so `/repo` and `/repo/` agree;
 * case-folded on the two platforms whose filesystems are case-insensitive, so a
 * drive-letter or capitalization difference doesn't split one project in two.
 */
export declare function exploreProjectKey(projectRoot: string): string;
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
export declare function coalesceRanges(ranges: ReadonlyArray<ExploreLineRange>, max?: number): {
    ranges: ExploreLineRange[];
    truncated: boolean;
};
/** Whether a line falls inside any of the (sorted, coalesced) ranges. */
export declare function rangesCover(ranges: ReadonlyArray<ExploreLineRange>, line: number): boolean;
/**
 * One MCP session's explore history. Created per session, thrown away with it.
 *
 * Not thread-shared and not a singleton: two sessions on the same daemon own two
 * instances and can never observe each other's calls. Every method is total —
 * malformed input is normalized away rather than thrown, because this sits on
 * the tool-call path and a bookkeeping bug must never fail an explore.
 */
export declare class ExploreSessionState {
    /** Insertion-ordered; a touched project is re-inserted, so the head is the LRU. */
    private readonly projects;
    /**
     * File an emission. Returns the record as stored (with its session call
     * index), or `null` if the emission was unusable.
     */
    record(emission: ExploreEmission): ExploreCallRecord | null;
    /** Full state for one project, or `null` if it was never queried this session. */
    forProject(projectRoot: string): ExploreProjectState | null;
    /** Explore calls made this session against a project (including evicted ones). */
    callCount(projectRoot: string): number;
    /** Every project this session has queried, least-recently-used first. */
    snapshot(): ExploreProjectState[];
    /**
     * The bounded view passed INTO a tool call. Trimmed to the most recent
     * {@link EXPLORE_SESSION_LIMITS.MAX_VIEW_CALLS} calls per project: it crosses a
     * worker boundary on every explore, so it carries what a dedup/decay decision
     * needs and not the whole history.
     */
    view(): ExploreSessionView;
    /** Drop everything. Used by tests; a real session just goes away instead. */
    clear(): void;
    /**
     * Fetch a project's state, creating it if new, and mark it most-recently-used.
     * Evicts the LRU project past the bound — dropping a project entirely (rather
     * than its detail) is right here: a session that has moved on to four other
     * repos is not about to re-ask the first one.
     */
    private touch;
    /**
     * Normalize + bound one call's files: coalesce each file's ranges, then keep
     * the files that got the most source. A call that renders more files than the
     * bound has already spread its envelope thin, so the tail files carry the
     * least — and losing them costs the least.
     */
    private boundFiles;
}
/**
 * Read the session view a caller injected into tool args, if any. Defensive:
 * the key is internal, but the args object comes off the wire, so a client that
 * spells it itself gets ignored rather than trusted into a crash.
 */
export declare function readExploreSessionView(args: Record<string, unknown>): ExploreSessionView | null;
/**
 * This session's prior state for one project, from an injected view.
 *
 * `null` means NOBODY IS TRACKING (no view was injected — the CLI, a bare
 * handler). A view that simply hasn't seen this project yet returns an EMPTY
 * state, not null: the distinction matters to consumers, since "first call of a
 * tracked session" and "untracked" are different situations.
 */
export declare function viewForProject(view: ExploreSessionView | null, projectRoot: string): ExploreProjectState | null;
//# sourceMappingURL=explore-session-state.d.ts.map