import { buildProviderOptions } from './providers.module';
import { USER_AGENT } from '../prometheus';

const makeConfig = (values: Record<string, unknown>) => ({ get: jest.fn((key: string) => values[key]) });

describe('buildProviderOptions', () => {
  const config = makeConfig({
    EL_RPC_URLS: ['https://a.example/x', 'https://b.example/y'],
    CHAIN_ID: 1,
    EL_RPC_MAX_RETRIES: 4,
    EL_RPC_RETRY_DELAY_MS: 250,
    EL_RPC_RESPONSE_TIMEOUT_MS: 1111,
  });

  it('turns every URL into a connection with the User-Agent and the response timeout', async () => {
    const options = await buildProviderOptions(config as any, {} as any);

    expect(options.urls).toEqual([
      { url: 'https://a.example/x', headers: { 'User-Agent': USER_AGENT }, timeout: 1111 },
      { url: 'https://b.example/y', headers: { 'User-Agent': USER_AGENT }, timeout: 1111 },
    ]);
    expect(options.network).toBe(1);
  });

  it('maps the retry variables so that the attempt count ends the retries', async () => {
    const options = await buildProviderOptions(config as any, {} as any);

    expect(options.maxRetries).toBe(4);
    expect(options.minBackoffMs).toBe(250);
    // the backoff doubles on every retry: 250, 500, 1000 for 4 attempts; the cap stays above the last one
    expect(options.maxBackoffMs).toBe(250 * 2 ** 4);
    expect(options.fetchMiddlewares).toHaveLength(1);
  });
});
