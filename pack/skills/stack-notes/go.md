# Stack: Go (net/http, Gin, Echo, Fiber)

**Layout**: `cmd/<app>/main.go`, `internal/{handler|api, service, repository|store, model}`, `pkg/`;
tests are `*_test.go` in the same package.

**Tests**
- Narrow run: `go test ./<pkg>/... -run '^TestName$'` (profile `test_one` with `{target}` = regex).
- Table-driven tests are the norm; follow the existing style.
- HTTP: `httptest.NewRecorder()` + the router/handler; DB: the project's test DB helper or interfaces with fakes.
- Race check for concurrency bugs: `go test -race ./<pkg>/...`.

**Pitfalls to check**
- Ignored `err` returns; error wrapped/compared wrongly (`errors.Is/As`).
- Nil map write, nil pointer on optional struct fields, typed-nil interface.
- Loop variable capture in goroutines/closures (Go < 1.22), goroutine leaks, missing `wg.Wait`.
- Data races on shared maps/slices; missing mutex.
- `defer rows.Close()`, `defer resp.Body.Close()` missing; context cancellation ignored.
- JSON: unexported fields are not serialized; struct tags (`json:"name,omitempty"`) — omitempty hides zero values.
- Time: `time.Now()` local vs UTC, `time.Parse` layout, integer division of durations.
- Slices sharing the same backing array after `append`.

**Never**: `t.Skip()` to pass, `_ = err` to silence a real error, change `go.mod` without need.
