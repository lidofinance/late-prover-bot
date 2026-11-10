import { retrier } from './func';

const makeLogger = () => ({ log: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() });

const failing = (attempts: { count: number }) =>
  jest.fn(async () => {
    attempts.count++;
    throw new Error(`fail ${attempts.count}`);
  });

describe('retrier', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('uses every retry when the backoff reaches the cap', async () => {
    const logger = makeLogger();
    const attempts = { count: 0 };
    const promise = retrier(logger as any, 20, 5000, 10000, true)(failing(attempts));
    promise.catch(() => undefined);

    // 5 s, then 10 s for every later retry: 19 sleeps in total
    await jest.advanceTimersByTimeAsync(5000 + 18 * 10000);
    await expect(promise).rejects.toThrow('fail 20');

    expect(attempts.count).toBe(20);
    const delays = logger.warn.mock.calls.map(([, context]) => context);
    expect(delays[0]).toContain('Retrying after (5000ms). Remaining retries [20]');
    expect(delays[1]).toContain('Retrying after (10000ms). Remaining retries [19]');
    expect(delays[delays.length - 1]).toContain('Retrying after (10000ms). Remaining retries [2]');
  });

  it('doubles the backoff below the cap', async () => {
    const logger = makeLogger();
    const attempts = { count: 0 };
    const promise = retrier(logger as any, 4, 500, 10000, true)(failing(attempts));
    promise.catch(() => undefined);

    await jest.advanceTimersByTimeAsync(500 + 1000 + 2000);
    await expect(promise).rejects.toThrow('fail 4');

    expect(attempts.count).toBe(4);
    expect(logger.warn.mock.calls.map(([, context]) => context)).toEqual([
      expect.stringContaining('Retrying after (500ms)'),
      expect.stringContaining('Retrying after (1000ms)'),
      expect.stringContaining('Retrying after (2000ms)'),
    ]);
  });

  it('stops at once with a single attempt', async () => {
    const attempts = { count: 0 };
    await expect(retrier(makeLogger() as any, 1, 500, 10000)(failing(attempts))).rejects.toThrow('fail 1');
    expect(attempts.count).toBe(1);
  });

  it('returns the first successful result', async () => {
    const logger = makeLogger();
    let calls = 0;
    const promise = retrier(
      logger as any,
      3,
      100,
      10000,
      true,
    )(async () => {
      calls++;
      if (calls < 2) throw new Error('first');
      return 'ok';
    });
    await jest.advanceTimersByTimeAsync(100);
    await expect(promise).resolves.toBe('ok');
    expect(calls).toBe(2);
  });
});
