import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { ENV_KEYS, collectSecrets, elRetryError, validate } from './env.validation';
import { logBootstrapError } from '../logger/bootstrap-logger';

// The real logger still writes to stderr; the mock only records the calls
jest.mock('../logger/bootstrap-logger', () => {
  const actual = jest.requireActual('../logger/bootstrap-logger');
  return { ...actual, logBootstrapError: jest.fn(actual.logBootstrapError) };
});

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
    // The validation error names the property and the constraint, never the value, so the text above would be
    // clean even without a mask: the secrets handed to the logger are the proof
    expect(logBootstrapError).toHaveBeenLastCalledWith(
      'Configuration validation failed',
      expect.stringContaining('HTTP_PORT'),
      expect.arrayContaining([KEY, KEY.slice(2), EL_URL, CL_URL]),
    );
  });

  it('rejects an EL attempt count the backoff cap cannot reach and names the maximum', () => {
    expect(() => validate({ ...baseConfig(), EL_RPC_MAX_RETRIES: '20' })).toThrow('exit 1');

    const text = stderrText();
    expect(text).toContain('EL_RPC_MAX_RETRIES=20 is not reachable with EL_RPC_RETRY_DELAY_MS=500');
    expect(text).toContain('the maximum is 6');
    expect(text).not.toContain(KEY);
  });

  it('accepts the highest reachable EL attempt count', () => {
    expect(validate({ ...baseConfig(), EL_RPC_MAX_RETRIES: '6' }).EL_RPC_MAX_RETRIES).toBe(6);
    expect(
      validate({ ...baseConfig(), EL_RPC_RETRY_DELAY_MS: '5000', EL_RPC_MAX_RETRIES: '2' }).EL_RPC_MAX_RETRIES,
    ).toBe(2);
  });

  it('trims the entries of the URL lists', () => {
    const config = validate({ ...baseConfig(), EL_RPC_URLS: `${EL_URL}, https://b.example/y ` });

    expect(config.EL_RPC_URLS).toEqual([EL_URL, 'https://b.example/y']);
  });

  it('rejects a locator that is not a 20 byte address and names only the variable', () => {
    // A key pasted into the wrong variable is not in the secrets list, so only the validation keeps it off stderr
    const misplacedKey = '0x' + 'cd'.repeat(32);

    expect(() => validate({ ...baseConfig(), LIDO_LOCATOR_ADDRESS: misplacedKey })).toThrow('exit 1');

    const text = stderrText();
    expect(text).toContain('LIDO_LOCATOR_ADDRESS');
    expect(text).toContain('matches');
    expect(text).not.toContain(misplacedKey.slice(2));
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

  it('checks the format of a key that is given in dry run too', () => {
    const badKey = '0x' + 'zz'.repeat(32);

    expect(() => validate({ ...baseConfig(), DRY_RUN: 'true', TX_SIGNER_PRIVATE_KEY: badKey })).toThrow('exit 1');
    expect(stderrText()).toContain('TX_SIGNER_PRIVATE_KEY');
    expect(stderrText()).not.toContain(badKey);

    expect(validate({ ...baseConfig(), DRY_RUN: 'true' }).TX_SIGNER_PRIVATE_KEY).toBe(KEY);
    expect(
      validate({ ...baseConfig(), DRY_RUN: 'true', TX_SIGNER_PRIVATE_KEY: undefined }).TX_SIGNER_PRIVATE_KEY,
    ).toBeUndefined();
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

describe('elRetryError', () => {
  const check = (EL_RPC_RETRY_DELAY_MS: number, EL_RPC_MAX_RETRIES: number) =>
    elRetryError({ EL_RPC_RETRY_DELAY_MS, EL_RPC_MAX_RETRIES });

  it('allows one attempt with any delay', () => {
    expect(check(60_000, 1)).toBeUndefined();
  });

  it('allows the sleeps 500, 1000, 2000, 4000, 8000 and rejects the sixth sleep of 16000', () => {
    expect(check(500, 6)).toBeUndefined();
    expect(check(500, 7)).toContain('the maximum is 6');
  });

  it('rejects a first delay at the cap when a retry is requested', () => {
    expect(check(10_000, 2)).toContain('the maximum is 1');
  });
});
