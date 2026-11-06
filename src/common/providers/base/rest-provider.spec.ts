import { request } from 'undici';

import { BaseRestProvider } from './rest-provider';
import { USER_AGENT } from '../../prometheus';

jest.mock('undici', () => ({ request: jest.fn() }));

const makeLogger = () => ({ log: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() });

class TestProvider extends BaseRestProvider {
  constructor() {
    super(['http://cl:5052'], 1000, 0, 0, makeLogger() as any);
  }

  get(endpoint: string, headers?: Record<string, string>) {
    return this.baseGet('http://cl:5052', endpoint, headers ? { headers } : undefined);
  }

  post(endpoint: string, body: unknown) {
    return this.basePost('http://cl:5052', endpoint, body);
  }
}

describe('BaseRestProvider request headers', () => {
  const mockedRequest = request as jest.MockedFunction<typeof request>;

  beforeEach(() => {
    mockedRequest.mockReset();
    mockedRequest.mockResolvedValue({ statusCode: 200, body: {}, headers: {} } as any);
  });

  it('sends the User-Agent with every GET request', async () => {
    await new TestProvider().get('eth/v1/node/version');

    const [url, options] = mockedRequest.mock.calls[0];
    expect(url).toBe('http://cl:5052/eth/v1/node/version');
    expect(options?.headers).toEqual({ 'User-Agent': USER_AGENT });
  });

  it('keeps the headers of the caller next to the User-Agent', async () => {
    await new TestProvider().get('eth/v2/debug/beacon/states/head', { Accept: 'application/octet-stream' });

    const [, options] = mockedRequest.mock.calls[0];
    expect(options?.headers).toEqual({ 'User-Agent': USER_AGENT, Accept: 'application/octet-stream' });
  });

  it('sends the User-Agent with every POST request', async () => {
    await new TestProvider().post('eth/v1/beacon/states/head/validators', { ids: ['1'] });

    const [, options] = mockedRequest.mock.calls[0];
    expect(options?.headers).toEqual({ 'Content-Type': 'application/json', 'User-Agent': USER_AGENT });
  });

  it('names the app and the version in the User-Agent', () => {
    expect(USER_AGENT).toMatch(/^late-prover-bot\/.+$/);
  });
});
