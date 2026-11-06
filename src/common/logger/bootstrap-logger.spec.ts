import { logBootstrapError } from './bootstrap-logger';

const KEY = '0x' + 'ab'.repeat(32);
const URL = 'https://el.example/v1/secret-token-el';

describe('logBootstrapError', () => {
  let stderr: jest.SpyInstance;

  beforeEach(() => {
    stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderr.mockRestore();
  });

  const lastLine = () => JSON.parse(String(stderr.mock.calls[stderr.mock.calls.length - 1][0]));

  it('writes one JSON line with the level and the context', () => {
    logBootstrapError('Configuration validation failed', 'property HTTP_PORT has failed', []);

    expect(stderr).toHaveBeenCalledTimes(1);
    expect(String(stderr.mock.calls[0][0]).endsWith('\n')).toBe(true);
    expect(lastLine()).toEqual({
      level: 'error',
      context: 'Bootstrap',
      message: 'Configuration validation failed',
      details: 'property HTTP_PORT has failed',
    });
  });

  it('masks the secret values in the message and in the details', () => {
    logBootstrapError(`failed for ${KEY}`, `key ${KEY.slice(2)} at ${URL} and ${KEY}`, [KEY, KEY.slice(2), URL]);

    const text = String(stderr.mock.calls[0][0]);
    expect(text).not.toContain(KEY);
    expect(text).not.toContain(KEY.slice(2));
    expect(text).not.toContain('secret-token-el');
    expect(lastLine().details).toContain(' at ');
  });

  it('masks secrets inside object details too', () => {
    logBootstrapError('failed', { nested: { url: URL, list: [KEY] } }, [KEY, URL]);

    const text = String(stderr.mock.calls[0][0]);
    expect(text).not.toContain(KEY);
    expect(text).not.toContain('secret-token-el');
    expect(lastLine().details.nested.list).toHaveLength(1);
  });
});
