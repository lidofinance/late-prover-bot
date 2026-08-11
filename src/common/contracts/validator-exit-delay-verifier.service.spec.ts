import { ethers } from 'ethers';

import { VerifierContract } from './validator-exit-delay-verifier.service';

const VERIFIER = '0x554c1f3D1E02F8c7203077021F626e6a0Af6B53C';
const OTHER_VERIFIER = '0x1111111111111111111111111111111111111111';

const GI_VALIDATORS = ethers.utils.id('GI_VALIDATORS()').slice(0, 10);
const word = (value: number) => ethers.utils.hexZeroPad(ethers.BigNumber.from(value).toHexString(), 32);

/**
 * Minimal provider: answers every view the service reads at startup, and either answers or reverts
 * GI_VALIDATORS - the getter that exists only on the verifier taking a block roots witness.
 */
const makeProvider = (knowsGiValidators: boolean) => ({
  _isProvider: true,
  call: jest.fn(async ({ data }: { data: string }) => {
    if (data.startsWith(GI_VALIDATORS)) {
      if (!knowsGiValidators) throw new Error('call revert exception');
      return word(1432);
    }
    return word(0);
  }),
});

const makeService = (addresses: string[], knowsGiValidators: boolean[]) => {
  const provider = makeProvider(true);
  const state = { provider };
  const locator = {
    getValidatorExitDelayVerifier: jest.fn(async () => addresses[Math.min(calls.locator++, addresses.length - 1)]),
  };
  const calls = { locator: 0, probe: 0 };

  const service = new (VerifierContract as any)(
    { get: jest.fn() }, // config
    {
      // A fresh provider per resolve, so the probe answer can change between cycles
      get provider() {
        state.provider = makeProvider(knowsGiValidators[Math.min(calls.probe++, knowsGiValidators.length - 1)]);
        return state.provider;
      },
    },
    locator,
  ) as VerifierContract & { [k: string]: any };

  return { service, locator };
};

describe('VerifierContract capability probing', () => {
  // The Gloas-capable verifier can be deployed before the fork, so this is a property of the
  // deployment and not of the chain - hence probed rather than configured.
  it('detects a verifier that takes a block roots witness', async () => {
    const { service } = makeService([VERIFIER], [true]);

    await service.refresh();

    expect(service.supportsBlockRootsWitness()).toBe(true);
  });

  it('detects the pre-Gloas verifier, which has no GI_VALIDATORS', async () => {
    const { service } = makeService([VERIFIER], [false]);

    await service.refresh();

    expect(service.supportsBlockRootsWitness()).toBe(false);
  });

  // The bot re-probes every cycle, so a protocol upgrade needs no restart
  it('follows an upgrade that changes what the verifier expects', async () => {
    const { service } = makeService([VERIFIER, VERIFIER], [false, true]);

    await service.refresh();
    expect(service.supportsBlockRootsWitness()).toBe(false);

    await service.refresh();
    expect(service.supportsBlockRootsWitness()).toBe(true);
  });

  it('follows an upgrade that moves the verifier to another address', async () => {
    const { service, locator } = makeService([VERIFIER, OTHER_VERIFIER], [false, true]);

    await service.refresh();
    await service.refresh();

    expect(locator.getValidatorExitDelayVerifier).toHaveBeenCalledTimes(2);
    expect(service.supportsBlockRootsWitness()).toBe(true);
  });
});
