import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { SecretFileError, applySecretFiles } from './env.files';

describe('applySecretFiles', () => {
  let dir: string;

  const file = (name: string, content: string | Buffer) => {
    const path = join(dir, name);
    writeFileSync(path, content);
    return path;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'late-prover-env-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps the env values when no _FILE variable is set', () => {
    const config = { TX_SIGNER_PRIVATE_KEY: '0xabc', EL_RPC_URLS: 'https://a/x', OTHER: '1' };

    expect(applySecretFiles(config)).toEqual(config);
  });

  it('reads the value from the file and drops leading and trailing whitespace', () => {
    const config = { TX_SIGNER_PRIVATE_KEY_FILE: file('key', ' \n0xabc\r\n') };

    expect(applySecretFiles(config)).toEqual({ ...config, TX_SIGNER_PRIVATE_KEY: '0xabc' });
  });

  it('prefers the file over the env value', () => {
    const config = {
      EL_RPC_URLS: 'https://env/x',
      EL_RPC_URLS_FILE: file('el', 'https://a/x,https://b/y'),
    };

    expect(applySecretFiles(config).EL_RPC_URLS).toBe('https://a/x,https://b/y');
  });

  it('treats an empty file as no value, even when the env has one', () => {
    const config = { TX_SIGNER_PRIVATE_KEY: '0xabc', TX_SIGNER_PRIVATE_KEY_FILE: file('key', '\n') };

    expect(applySecretFiles(config)).not.toHaveProperty('TX_SIGNER_PRIVATE_KEY');
  });

  it('ignores an empty _FILE variable', () => {
    const config = { CL_API_URLS: 'https://cl/x', CL_API_URLS_FILE: '' };

    expect(applySecretFiles(config)).toEqual(config);
  });

  it('fails on a missing file without quoting any content', () => {
    const path = join(dir, 'missing');

    expect(() => applySecretFiles({ CL_API_URLS_FILE: path })).toThrow(SecretFileError);
    expect(() => applySecretFiles({ CL_API_URLS_FILE: path })).toThrow(
      `CL_API_URLS_FILE points to a file that cannot be read (ENOENT): ${path}`,
    );
  });

  it('fails on a file that is not UTF-8 text without quoting its content', () => {
    const path = file('binary', Buffer.concat([Buffer.from('0xsecretvalue'), Buffer.from([0xff, 0xfe])]));

    let message = '';
    try {
      applySecretFiles({ EL_RPC_URLS_FILE: path });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain(`EL_RPC_URLS_FILE points to ${path}, which is not UTF-8 text`);
    expect(message).not.toContain('secretvalue');
  });

  it('fails on a directory without quoting anything from it', () => {
    expect(() => applySecretFiles({ EL_RPC_URLS_FILE: dir })).toThrow(
      `EL_RPC_URLS_FILE points to a file that cannot be read (EISDIR): ${dir}`,
    );
  });

  it('does not change the input object', () => {
    const config = { TX_SIGNER_PRIVATE_KEY_FILE: file('key', '0xabc') };
    const copy = { ...config };

    applySecretFiles(config);

    expect(config).toEqual(copy);
  });
});
