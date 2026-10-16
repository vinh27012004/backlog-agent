# Stack: .NET / C# (ASP.NET Core, EF Core)

**Layout**: `src/<Project>.{Api|Web, Application, Domain, Infrastructure}`; controllers or minimal APIs,
services, `DbContext` + entities, DTOs; tests in `tests/<Project>.Tests` (xUnit/NUnit/MSTest).

**Tests**
- Narrow run: `test_one` with a fully qualified test name fragment (`Namespace.Class.Method`).
- Web: `WebApplicationFactory<Program>` + `HttpClient`; services with Moq/NSubstitute.
- EF Core: the project's in-memory/SQLite setup; beware InMemory provider ignores constraints/transactions.
- Time: inject `TimeProvider`/`ISystemClock` if available.

**Pitfalls to check**
- Nullable reference types warnings ignored → runtime `NullReferenceException`.
- `async void`, missing `await`, `.Result`/`.Wait()` deadlocks.
- EF: missing `Include`, tracking vs `AsNoTracking`, `SaveChanges` not called, N+1 via lazy loading, new migration needed after model change.
- `decimal` vs `double` for money; `Math.Round` default is banker's rounding (`MidpointRounding`).
- `DateTime.Now` vs `UtcNow`, `DateTimeKind`, `DateOnly`.
- DI lifetimes: scoped service captured in a singleton.
- Model validation: `[ApiController]` auto-400, data annotations, FluentValidation registration.
- JSON: System.Text.Json naming policy/case sensitivity differs from Newtonsoft.

**Never**: `[Fact(Skip=...)]`/`[Ignore]`, `#pragma warning disable` to hide a real problem, edit an applied migration.
