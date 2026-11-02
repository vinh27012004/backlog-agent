# Stack: Java / Kotlin (Spring Boot, Maven/Gradle)

**Layout**: `src/main/java/<pkg>/{controller|web, service, repository|dao, entity|domain|model, dto, config, exception}`;
tests mirror the package under `src/test/java`. Config in `src/main/resources/application*.yml|properties`
(profile-specific files override the base one).

**Tests**
- Unit: JUnit 5 (`@Test`), AssertJ/Hamcrest, Mockito (`@ExtendWith(MockitoExtension.class)`).
- Web layer: `@WebMvcTest(XController.class)` + `MockMvc`; full: `@SpringBootTest` (+ `@AutoConfigureMockMvc`) — slow, use only if needed.
- Persistence: `@DataJpaTest` (H2/Testcontainers as the project already does).
- Narrow run: `test_one` with `Class#method`; multi-module Maven: add `-pl <module> -am`.
- Fixed clock: inject `java.time.Clock` if the code supports it; otherwise test the pure function.

**Pitfalls to check**
- `@Transactional` on private/self-invoked methods has no effect; read-only tx used for writes.
- JPA: `LazyInitializationException` outside the session, N+1 with lazy collections, `equals/hashCode` on entities, `save()` vs dirty checking.
- Money: `BigDecimal` with `equals` (scale!) vs `compareTo`; `setScale` + `RoundingMode`; never `double`.
- Dates: `LocalDate.now()` uses the JVM zone; `Instant` vs `LocalDateTime`; month end; `between` exclusivity.
- `Optional.get()` without check; `Integer` unboxing NPE; `==` on `String`/`Integer`.
- Jackson: field naming strategy, `@JsonIgnore`, enum (de)serialization, `LocalDate` format.
- Validation: `@Valid` missing on the controller parameter, so annotations on the DTO are ignored.
- Exceptions: `@ControllerAdvice` mapping decides the status code — check it before changing controllers.
- Spring Security: method security vs URL rules; CSRF for non-GET in tests (`with(csrf())`).

**Never**: `@Disabled`/`@Ignore` tests, change `pom.xml`/`build.gradle` without need, catch `Exception` to hide a failure.
