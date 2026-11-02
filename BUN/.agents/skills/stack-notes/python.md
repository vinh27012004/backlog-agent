# Stack: Python (Django, FastAPI, Flask)

**Layout**: Django `<app>/{models.py, views.py, serializers.py, urls.py, services.py, tests/}`;
FastAPI/Flask `app/{routers|api, services, models, schemas, db}`, tests under `tests/`.

**Tests**
- pytest: narrow run with `test_one` using `path/to/test_file.py::TestClass::test_name` (or `-k "<expr>"`).
- unittest (profile `test_framework: unittest`, when the project does not declare pytest): `test_one` with a
  dotted name `tests.test_module` or `tests.test_module.TestClass.test_name`; do not add pytest.
- Django: `python manage.py test app.tests.TestClass.test_name`, or pytest-django if configured.
- FastAPI: `TestClient(app)` + dependency overrides; Flask: `app.test_client()`.
- Fixtures in `conftest.py`; reuse existing factories (factory_boy, model_bakery) instead of new ones.
- Time: `freezegun` / `time-machine` if present, otherwise pass the date in.

**Pitfalls to check**
- Mutable default arguments (`def f(x=[])`); shared module-level state.
- `None` handling, `dict[key]` vs `.get`, truthiness of `0`/empty.
- Money: `Decimal` (construct from `str`, not `float`), `quantize` with rounding.
- Dates: naive vs aware datetimes, `USE_TZ`, `date.today()` vs `timezone.now()`, inclusive ranges.
- Django ORM: N+1 (`select_related`/`prefetch_related`), `filter().first()` returning None, `.update()` skipping signals, missing migrations after model change (`makemigrations`).
- Pydantic: v1 vs v2 API, optional fields defaults, aliases vs field names in responses.
- Async: blocking calls in `async def`; missing `await`.
- Integer division `//` vs `/`.

**Never**: `@pytest.mark.skip`/`xfail` to pass, bare `except:` to hide errors, edit an applied migration.
