import { NonEmptyArray } from '@lido-nestjs/execution';

import { PatchedFallbackProvider } from './patched-fallback-provider';

const mockLogger = {
  log: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

const network = { chainId: 1, name: 'mainnet' };

// maxRetries:1 so each provider is tried once with no backoff sleep
const makeProvider = (urls: NonEmptyArray<string> = ['http://localhost:9999']) =>
  new PatchedFallbackProvider({ urls, network, maxRetries: 1, minBackoffMs: 0 }, mockLogger);

// Initialize fallback provider network so the internal `isValid` check passes
const initNetworks = (provider: PatchedFallbackProvider) => {
  (provider as any).fallbackProviders.forEach((fp: any) => {
    fp.network = network;
  });
};

const fetchErrorCallException = () =>
  Object.assign(new Error('missing revert data in call exception'), {
    code: 'CALL_EXCEPTION',
    data: '0x',
    error: { name: 'FetchError', code: 19, message: 'Temporary internal error. Please retry.' },
  });

const realContractRevert = () =>
  Object.assign(new Error('execution reverted'), {
    code: 'CALL_EXCEPTION',
    data: '0x08c379a0',
    reason: 'execution reverted',
  });

// ─── isNonRetryableError unit tests ──────────────────────────────────────────

describe('PatchedFallbackProvider.isNonRetryableError', () => {
  let provider: PatchedFallbackProvider;

  beforeEach(() => {
    provider = makeProvider();
  });

  describe('CALL_EXCEPTION wrapping a FetchError (transient RPC failure)', () => {
    it('returns false so the fallback switches to the next provider', () => {
      expect(provider.isNonRetryableError(fetchErrorCallException())).toBe(false);
    });

    it('returns false regardless of the FetchError message content', () => {
      const error = Object.assign(new Error('call exception'), {
        code: 'CALL_EXCEPTION',
        error: { name: 'FetchError', code: 503 },
      });
      expect(provider.isNonRetryableError(error)).toBe(false);
    });
  });

  describe('real CALL_EXCEPTION (contract revert — non-retryable)', () => {
    it('returns true when there is no inner error', () => {
      expect(provider.isNonRetryableError(realContractRevert())).toBe(true);
    });

    it('returns true when the inner error is not a FetchError', () => {
      const error = Object.assign(new Error('execution reverted'), {
        code: 'CALL_EXCEPTION',
        error: { name: 'Error', message: 'execution reverted' },
      });
      expect(provider.isNonRetryableError(error)).toBe(true);
    });
  });

  describe('other ethers error codes (delegated to base class)', () => {
    it('returns true for INVALID_ARGUMENT', () => {
      expect(provider.isNonRetryableError(Object.assign(new Error(), { code: 'INVALID_ARGUMENT' }))).toBe(true);
    });

    it('returns true for INSUFFICIENT_FUNDS', () => {
      expect(provider.isNonRetryableError(Object.assign(new Error(), { code: 'INSUFFICIENT_FUNDS' }))).toBe(true);
    });

    it('returns true for UNPREDICTABLE_GAS_LIMIT', () => {
      expect(provider.isNonRetryableError(Object.assign(new Error(), { code: 'UNPREDICTABLE_GAS_LIMIT' }))).toBe(true);
    });

    it('returns false for a plain network error without a code', () => {
      expect(provider.isNonRetryableError(new Error('network error'))).toBe(false);
    });

    it('returns false for a server error (has serverError property)', () => {
      const error = Object.assign(new Error('server error'), {
        code: 'SERVER_ERROR',
        serverError: new Error('upstream'),
      });
      expect(provider.isNonRetryableError(error)).toBe(false);
    });
  });
});

// ─── Full fallback integration tests ─────────────────────────────────────────

describe('PatchedFallbackProvider fallback behavior (perform)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('routes to the second provider when the first returns CALL_EXCEPTION caused by FetchError', async () => {
    const provider = makeProvider(['http://localhost:1', 'http://localhost:2']);
    initNetworks(provider);

    const [fp0, fp1] = (provider as any).fallbackProviders;
    jest.spyOn(fp0.provider, 'perform').mockRejectedValue(fetchErrorCallException());
    jest.spyOn(fp1.provider, 'perform').mockResolvedValue('0x1234');

    const result = await provider.perform('eth_call', { to: '0xdead', data: '0x' });

    expect(result).toBe('0x1234');
    expect(fp0.provider.perform).toHaveBeenCalledTimes(1);
    expect(fp1.provider.perform).toHaveBeenCalledTimes(1);
  });

  it('does NOT route to the second provider for a real contract revert', async () => {
    const provider = makeProvider(['http://localhost:1', 'http://localhost:2']);
    initNetworks(provider);

    const [fp0, fp1] = (provider as any).fallbackProviders;
    jest.spyOn(fp0.provider, 'perform').mockRejectedValue(realContractRevert());
    jest.spyOn(fp1.provider, 'perform').mockResolvedValue('0x1234');

    await expect(provider.perform('eth_call', { to: '0xdead', data: '0x' })).rejects.toMatchObject({
      code: 'CALL_EXCEPTION',
    });
    expect(fp0.provider.perform).toHaveBeenCalledTimes(1);
    expect(fp1.provider.perform).not.toHaveBeenCalled();
  });

  it('throws AllProvidersFailedError when all providers return FetchError-wrapped CALL_EXCEPTION', async () => {
    const provider = makeProvider(['http://localhost:1', 'http://localhost:2']);
    initNetworks(provider);

    const [fp0, fp1] = (provider as any).fallbackProviders;
    jest.spyOn(fp0.provider, 'perform').mockRejectedValue(fetchErrorCallException());
    jest.spyOn(fp1.provider, 'perform').mockRejectedValue(fetchErrorCallException());

    await expect(provider.perform('eth_call', { to: '0xdead', data: '0x' })).rejects.toMatchObject({
      message: expect.stringContaining('All attempts'),
    });
    expect(fp0.provider.perform).toHaveBeenCalledTimes(1);
    expect(fp1.provider.perform).toHaveBeenCalledTimes(1);
  });
});
