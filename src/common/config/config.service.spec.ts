import { ConfigService } from './config.service';
import { ENV_KEYS } from './env.validation';

const KEY = '0x' + 'ab'.repeat(32);
const EL_URL = 'https://el.example/v1/secret-token-el';
const CL_URL = 'https://cl.example/secret-token-cl';
const LOCATOR = '0xC1d0b3DE6792Bf6b4b37EccdcC24e45978Cfd2Eb';

const makeService = (overrides: Record<string, unknown> = {}) => {
  const values: Record<string, unknown> = {
    EL_RPC_URLS: [EL_URL],
    CL_API_URLS: [CL_URL],
    TX_SIGNER_PRIVATE_KEY: KEY,
    TX_SIGNER_PRIVATE_KEY_FILE: '/vault/secrets/tx-signer-private-key',
    EL_RPC_URLS_FILE: '/vault/secrets/el-rpc-urls',
    LIDO_LOCATOR_ADDRESS: LOCATOR,
    HTTP_PORT: 8080,
    DRY_RUN: false,
    ...overrides,
  };
  const service = new ConfigService();
  jest.spyOn(service, 'get').mockImplementation(((key: string) => values[key]) as any);
  return service;
};

describe('ConfigService.secrets', () => {
  it('lists the URLs and the key with and without 0x', () => {
    expect(makeService().secrets).toEqual([EL_URL, CL_URL, KEY, KEY.slice(2)]);
  });

  it('lists only the URLs without a key', () => {
    expect(makeService({ TX_SIGNER_PRIVATE_KEY: undefined }).secrets).toEqual([EL_URL, CL_URL]);
  });
});

describe('ConfigService.dump', () => {
  it('has every variable of ENV_KEYS', () => {
    expect(Object.keys(makeService().dump()).sort()).toEqual([...ENV_KEYS].sort());
  });

  it('masks the key and the URLs, and keeps the file paths and the public values', () => {
    const dump = makeService().dump();
    const text = JSON.stringify(dump);

    expect(text).not.toContain(KEY);
    expect(text).not.toContain(KEY.slice(2));
    expect(text).not.toContain('secret-token-el');
    expect(text).not.toContain('secret-token-cl');
    expect(dump.TX_SIGNER_PRIVATE_KEY).toMatch(/^\*+$/);
    expect(dump.EL_RPC_URLS).toEqual([expect.stringMatching(/^\*+$/)]);
    expect(dump.TX_SIGNER_PRIVATE_KEY_FILE).toBe('/vault/secrets/tx-signer-private-key');
    expect(dump.EL_RPC_URLS_FILE).toBe('/vault/secrets/el-rpc-urls');
    expect(dump.HTTP_PORT).toBe(8080);
    expect(dump.DRY_RUN).toBe(false);
  });

  it('masks the locator address through the common address pattern (known trade-off)', () => {
    // The platform masking patterns hide every 40+ character hex string, so the public LIDO_LOCATOR_ADDRESS is
    // masked in the dump as well. It is visible in the build_info metric labels.
    expect(makeService().dump().LIDO_LOCATOR_ADDRESS).toMatch(/^\*+$/);
  });
});
