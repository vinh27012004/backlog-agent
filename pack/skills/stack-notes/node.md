# Stack: Node.js / TypeScript (Express, NestJS, Next.js, React, Vue)

**Layout**: backend `src/{routes|controllers, services, repositories|models, middlewares, dto|schemas}`;
NestJS `src/<feature>/{*.module, *.controller, *.service, dto/, entities/}`; React/Next `src/{components, pages|app, hooks, api|services}`.
Tests: `*.test.ts|*.spec.ts` next to the file or under `__tests__/`/`test/`.

**Tests**
- Jest or Vitest (see profile). Narrow run: `test_one` with the test file path, add `-t "<test name>"`.
- HTTP: `supertest` against the app/server instance; NestJS: `Test.createTestingModule` with mocked providers.
- React: Testing Library (`render`, `screen`, `userEvent`); mock fetch/axios at the module boundary.
- Time: `vi.useFakeTimers()` / `jest.useFakeTimers()` + `setSystemTime`.
- Type check is part of the build: run `npx tsc --noEmit` if the project uses TypeScript.

**Pitfalls to check**
- Missing `await` (promise returned instead of value; errors become unhandled rejections).
- `==` vs `===`, truthiness of `0`/`""`, `undefined` vs `null` in JSON (undefined fields disappear).
- Number precision for money (use integer cents or the project's decimal library); `parseInt` without radix.
- Dates: `new Date("YYYY-MM-DD")` is UTC, `toISOString()` shifts to UTC; months are 0-based.
- Array mutation (`sort`, `splice`) on shared data; React state mutated instead of replaced; stale closures in hooks; missing `key`/dependency arrays.
- Express: error middleware must have 4 args; async handlers need error forwarding.
- ORM (Prisma/TypeORM/Sequelize/Mongoose): missing `include/relations`, transactions, `findOne` returning null.
- Env config read at import time vs runtime.
- Next.js dev (`next dev --turbo`) + Tailwind v4: logical utilities behind a breakpoint (`md:ms-*`, `md:ps-*`, `md:pe-*`,
  `md:start-*`) compile to an empty `@media {}` block (Lightning CSS drops nested logical properties for Next's default
  browser targets); the production build is fine. When the MVS checks dev, use a plain CSS rule
  `@media (min-width: 48rem) { .x { margin-inline-start: ... } }` in the global stylesheet (or the physical utility
  if the app has no RTL) instead of debugging Tailwind. Never change browserslist or build config for it.

**Never**: `.skip`/`.only`/`xit` in tests, `// @ts-ignore` or `any` to silence a real type error, edit lockfiles by hand.
