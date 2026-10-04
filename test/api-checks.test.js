"use strict";
/* API regex checks on qa-api: status_only_assert, mocked_service, no_negative_cases, test_data_no_cleanup,
   response_time_assert. What must not count is next to each case. */
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./helpers");

const { Lens } = load();

const found = (file, content, check) =>
  Lens.runChecks([{ seq: 1, kind: "write", file, new_content: content }], Lens.profile("qa-api"))
    .filter((f) => f.check === check)
    .map((f) => `${f.severity}: ${f.message}`);

test("status_only_assert: every assertion is the HTTP status", () => {
  assert.deepEqual(
    found(
      "tests/orders.spec.ts",
      "it('creates an order', async () => {\n  const r = await request.post('/orders');\n  expect(r.status).toBe(201);\n});\n",
      "status_only_assert",
    ),
    ["medium: tests/orders.spec.ts: creates an order — asserts only the status code; the body, headers and schema are not checked"],
  );
  assert.deepEqual(
    found(
      "tests/orders.spec.ts",
      "it('creates an order', async () => {\n  const r = await request.post('/orders');\n  expect(r.status).toBe(201);\n  expect(r.body.id).toBeTruthy();\n});\n",
      "status_only_assert",
    ),
    [],
  );
});

test("mocked_service: nock / jest.mock of an HTTP client", () => {
  assert.deepEqual(
    found(
      "tests/orders.spec.ts",
      "nock('https://shop.test').get('/orders').reply(200, []);\nit('lists', async () => {\n  expect(true).toBe(true);\n});\n",
      "mocked_service",
    ),
    ["medium: tests/orders.spec.ts: HTTP calls are mocked (nock() — make sure the API under test is real; mock only its downstream dependencies"],
  );
  assert.deepEqual(
    found(
      "tests/orders.spec.ts",
      "it('lists', async () => {\n  const r = await request.get('/orders');\n  expect(r.status).toBe(200);\n});\n",
      "mocked_service",
    ),
    [],
  );
  assert.deepEqual(
    found(
      "tests/orders.spec.ts",
      "jest.mock('./utils');\nit('lists', async () => {\n  const r = await request.get('/orders');\n  expect(r.body).toEqual([]);\n});\n",
      "mocked_service",
    ),
    [],
    "a mocked local module is not a mocked HTTP client",
  );
});

test("no_negative_cases: two happy-path tests and no error status", () => {
  const twoHappy = "it('creates', async () => {\n  expect(r.status).toBe(201);\n});\nit('lists', async () => {\n  expect(r.status).toBe(200);\n});\n";
  assert.deepEqual(found("tests/orders.spec.ts", twoHappy, "no_negative_cases"), [
    "medium: 2 API test(s) written, none checks an error response (401/403/404/400/422) — only the happy path is covered",
  ]);
  const with401 =
    "it('creates', async () => {\n  expect(r.status).toBe(201);\n});\nit('rejects a missing token', async () => {\n  expect(r.status).toBe(401);\n});\n";
  assert.deepEqual(found("tests/orders.spec.ts", with401, "no_negative_cases"), []);
  assert.deepEqual(
    found("tests/orders.spec.ts", "it('creates', async () => {\n  expect(r.status).toBe(201);\n});\n", "no_negative_cases"),
    [],
    "one test is not enough",
  );
});

test("test_data_no_cleanup: POST that creates, with no delete or teardown", () => {
  assert.deepEqual(
    found(
      "tests/users.spec.ts",
      "it('creates a user', async () => {\n  await client.post('/users', { name: 'Ada' });\n  expect(true).toBe(true);\n});\n",
      "test_data_no_cleanup",
    ),
    ["low: tests/users.spec.ts: creates data (/users) but never removes it — repeated runs will collide"],
  );
  assert.deepEqual(
    found(
      "tests/users.spec.ts",
      "it('creates a user', async () => {\n  await client.post('/users', { name: 'Ada' });\n  await client.delete('/users/1');\n});\n",
      "test_data_no_cleanup",
    ),
    [],
  );
  assert.deepEqual(
    found("tests/auth.spec.ts", "it('logs in', async () => {\n  await client.post('/login', { user: 'ada' });\n});\n", "test_data_no_cleanup"),
    [],
  );
});

test("response_time_assert: elapsed / lessThan on an assertion line", () => {
  assert.deepEqual(found("tests/orders.spec.ts", "it('is fast', async () => {\n  expect(r.elapsed).toBeLessThan(200);\n});\n", "response_time_assert"), [
    "low: tests/orders.spec.ts: is fast — asserts response time (expect(r.elapsed).toBeLessThan(200);); this fails on a slow CI runner",
  ]);
  assert.deepEqual(found("tests/orders.spec.ts", "it('creates', async () => {\n  expect(r.status).toBe(201);\n});\n", "response_time_assert"), []);
  assert.deepEqual(
    found("tests/orders.spec.ts", "it('creates', async () => {\n  console.log(r.elapsed);\n  expect(r.body.id).toBeTruthy();\n});\n", "response_time_assert"),
    [],
    "the time is logged, not asserted",
  );
});
