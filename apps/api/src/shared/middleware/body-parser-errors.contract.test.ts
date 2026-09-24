import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiPath, routes } from '@pfm/contracts';
import {
  ALICE_ACCOUNTS,
  isoDaysAgo,
  startHarness,
  type Harness,
} from '../../test/harness.js';
import { expectProblem } from '../../test/problem.js';

const entries = apiPath(routes.entries);
const MARKER = 'raw-body-marker-7f3a';

let h: Harness;

beforeAll(async () => {
  h = await startHarness();
});

afterAll(async () => {
  await h.close();
});

describe('a body that is not valid JSON', () => {
  it.each([
    ['POST /entries', () => request(h.app).post(entries)],
    [
      'POST /entries/:id/correction',
      () =>
        request(h.app).post(
          apiPath(routes.entryCorrection('00000000-0000-4000-8000-0000000000b1')),
        ),
    ],
  ])('is a 400 problem+json on %s, typed malformed-json, without echoing the body', async (_label, start) => {
    const before = await h.db.entry.count();

    const res = await start()
      .set('Content-Type', 'application/json')
      .send(`{"payee":"${MARKER}",`);

    expect(res.status).not.toBe(500);
    const problem = expectProblem(res, 400);
    expect(problem.type).toContain('malformed-json');
    if (problem.detail !== undefined) {
      expect(problem.detail.length).toBeGreaterThan(0);
    }
    expect(res.text).not.toContain(MARKER);
    expect(await h.db.entry.count()).toBe(before);
  });

  it('is a 400 for a truncated body like {"a":', async () => {
    const res = await request(h.app)
      .post(entries)
      .set('Content-Type', 'application/json')
      .send('{"a":');

    expect(res.status).not.toBe(500);
    expectProblem(res, 400);
  });
});

describe('a JSON body over the size limit', () => {
  it('is a 413 problem+json, not a 500, and writes nothing', async () => {
    const before = await h.db.entry.count();
    const body = JSON.stringify({
      occurredOn: isoDaysAgo(1),
      accountId: ALICE_ACCOUNTS.checking,
      categoryId: ALICE_ACCOUNTS.groceries,
      amountMinor: '-100',
      memo: `${MARKER}${'x'.repeat(200 * 1024)}`,
    });

    const res = await request(h.app)
      .post(entries)
      .set('Content-Type', 'application/json')
      .send(body);

    expect(res.status).not.toBe(500);
    expectProblem(res, 413);
    expect(res.text).not.toContain(MARKER);
    expect(await h.db.entry.count()).toBe(before);
  });
});
