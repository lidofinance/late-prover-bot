import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { ENV_KEYS, collectSecrets, validate } from './env.validation';

const KEY = '0x' + 'ab'.repeat(32);
const EL_URL = 'https://el.example/v1/secret-token-el';
const CL_URL = 'https://cl.example/secret-token-cl';

const baseConfig = (): Record<string, unknown> => ({
  CHAIN_ID: '1',
  LIDO_LOCATOR_ADDRESS: '0xC1d0b3DE6792Bf6b4b37EccdcC24e45978Cfd2Eb',
  EL_RPC_URLS: EL_URL,
  CL_API_URLS: CL_URL,
  TX_SIGNER_PRIVATE_KEY: KEY,
});

describe('validate', () => {
  let dir: string;
  let exit: jest.SpyInstance;
  let stderr: jest.SpyInstance;

  const stderrText = () => stderr.mock.calls.map((call) => String(call[0])).join('');

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'late-prover-validate-'));
    exit = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    exit.mockRestore();
    stderr.mockRestore();
  });

  it('accepts a config from the env as before', () => {
    const config = validate(baseConfig());

    expect(config.EL_RPC_URLS).toEqual([EL_URL]);
    expect(config.TX_SIGNER_PRIVATE_KEY).toBe(KEY);
    expect(config.WORKING_MODE).toBe('daemon');
    expect(exit).not.toHaveBeenCalled();
  });

  it('takes the secrets from the files named by the _FILE variables', () => {
    const keyFile = join(dir, 'key');
    const elFile = join(dir, 'el');
    writeFileSync(keyFile, `${KEY}\n`);
    writeFileSync(elFile, 'https://a.example/x,https://b.example/y\n');

    const config = validate({
      ...baseConfig(),
      TX_SIGNER_PRIVATE_KEY: '0xenv',
      TX_SIGNER_PRIVATE_KEY_FILE: keyFile,
      EL_RPC_URLS_FILE: elFile,
    });

    expect(config.TX_SIGNER_PRIVATE_KEY).toBe(KEY);
    expect(config.EL_RPC_URLS).toEqual(['https://a.example/x', 'https://b.example/y']);
    expect(config.TX_SIGNER_PRIVATE_KEY_FILE).toBe(keyFile);
  });

  it('treats an empty key file as no key: fails without DRY_RUN, passes with it', () => {
    const keyFile = join(dir, 'key');
    writeFileSync(keyFile, '');

    expect(() => validate({ ...baseConfig(), TX_SIGNER_PRIVATE_KEY_FILE: keyFile })).toThrow('exit 1');
    expect(stderrText()).toContain('TX_SIGNER_PRIVATE_KEY');

    const config = validate({ ...baseConfig(), DRY_RUN: 'true', TX_SIGNER_PRIVATE_KEY_FILE: keyFile });
    expect(config.TX_SIGNER_PRIVATE_KEY).toBeUndefined();
  });

  it('stops on a missing secret file and names the variable, not the content', () => {
    const path = join(dir, 'missing');

    expect(() => validate({ ...baseConfig(), CL_API_URLS_FILE: path })).toThrow('exit 1');

    const text = stderrText();
    expect(text).toContain('CL_API_URLS_FILE');
    expect(text).toContain('Configuration validation failed');
    expect(text).not.toContain(KEY);
    expect(text).not.toContain(EL_URL);
  });

  it('masks the secret values in the validation errors', () => {
    expect(() => validate({ ...baseConfig(), HTTP_PORT: 'not-a-port' })).toThrow('exit 1');

    const text = stderrText();
    expect(text).toContain('HTTP_PORT');
    expect(text).not.toContain(KEY);
    expect(text).not.toContain(KEY.slice(2));
    expect(text).not.toContain('secret-token-el');
    expect(text).not.toContain('secret-token-cl');
  });

  it('rejects a key that is not 64 hex characters and names only the variable', () => {
    const badKey = '0x' + 'zz'.repeat(32);

    expect(() => validate({ ...baseConfig(), TX_SIGNER_PRIVATE_KEY: badKey })).toThrow('exit 1');

    const text = stderrText();
    expect(text).toContain('TX_SIGNER_PRIVATE_KEY');
    expect(text).toContain('matches');
    expect(text).not.toContain(badKey);
    expect(text).not.toContain(badKey.slice(2));
  });

  it('accepts the key with and without 0x', () => {
    expect(validate({ ...baseConfig(), TX_SIGNER_PRIVATE_KEY: KEY.slice(2) }).TX_SIGNER_PRIVATE_KEY).toBe(KEY.slice(2));
    expect(validate(baseConfig()).TX_SIGNER_PRIVATE_KEY).toBe(KEY);
  });

  it('rejects an empty URL in the lists', () => {
    expect(() => validate({ ...baseConfig(), EL_RPC_URLS: '' })).toThrow('exit 1');
    expect(() => validate({ ...baseConfig(), CL_API_URLS: `${CL_URL},` })).toThrow('exit 1');
  });

  it('rejects EL retry settings the provider cannot use', () => {
    expect(() => validate({ ...baseConfig(), EL_RPC_MAX_RETRIES: '0' })).toThrow('exit 1');
    expect(() => validate({ ...baseConfig(), EL_RPC_MAX_RETRIES: '21' })).toThrow('exit 1');
    expect(() => validate({ ...baseConfig(), EL_RPC_RETRY_DELAY_MS: '0' })).toThrow('exit 1');
    expect(validate({ ...baseConfig(), EL_RPC_MAX_RETRIES: '1', EL_RPC_RETRY_DELAY_MS: '1' }).EL_RPC_MAX_RETRIES).toBe(
      1,
    );
  });

  it('lists every variable of the class in ENV_KEYS', () => {
    const config = validate({
      ...baseConfig(),
      TX_SIGNER_PRIVATE_KEY_FILE: '',
      EL_RPC_URLS_FILE: '',
      CL_API_URLS_FILE: '',
    });

    expect([...ENV_KEYS].sort()).toEqual(Object.keys(config).sort());
  });
});

describe('collectSecrets', () => {
  it('returns the key with and without 0x and every URL of the lists', () => {
    const secrets = collectSecrets({
      TX_SIGNER_PRIVATE_KEY: '0xabc',
      EL_RPC_URLS: 'https://a/x, https://b/y',
      CL_API_URLS: '',
    });

    expect(secrets).toEqual(['0xabc', 'abc', 'https://a/x', 'https://b/y']);
  });
});
