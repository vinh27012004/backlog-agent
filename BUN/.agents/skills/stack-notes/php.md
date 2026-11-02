# Stack: PHP (Laravel, Symfony)

**Layout**: Laravel `app/{Http/Controllers, Http/Requests, Models, Services, Policies}`, `routes/`,
`database/migrations`, `tests/{Unit,Feature}`; Symfony `src/{Controller, Entity, Repository, Service}`, `tests/`.

**Tests**
- Narrow run: `test_one` with `--filter TestClass::test_method`.
- Laravel feature tests: `$this->getJson(...)->assertStatus(...)->assertJson(...)`, `RefreshDatabase`, factories.
- Time: `Carbon::setTestNow()` / `$this->travelTo()`.

**Pitfalls to check**
- Loose comparison `==` (`"abc" == 0` in old PHP, `"1e3" == "1000"`); use `===`.
- `null` from `find()`/`first()`; `firstOrFail` vs `first`.
- Eloquent: N+1 (`with()`), mass assignment (`$fillable`/`$guarded`), accessors/casts changing types, soft deletes hiding rows.
- Validation in Form Requests vs controller; custom messages; `sometimes` vs `required`.
- Money: floats → use integer minor units or bcmath/brick/money as the project does.
- Dates: Carbon mutability (`copy()`), app timezone vs DB timezone, `startOfMonth`/`endOfMonth`.
- Config cached (`config:cache`) vs `env()` called outside config files.
- Authorization: Policies/Gates not applied on the route.

**Never**: `markTestSkipped`, `@` error suppression to hide a failure, edit an applied migration.
