import { Execution } from './execution';

const makeLogger = () => ({ log: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() });

const makeExecution = () => {
  const logger = makeLogger();
  const values: Record<string, unknown> = { TX_CONFIRMATIONS: 2, TX_MINING_WAITING_TIMEOUT_MS: 1000 };
  const config = { get: jest.fn((key: string) => values[key]) };
  const provider = {
    sendTransaction: jest.fn().mockResolvedValue({ hash: '0xabc' }),
    waitForTransaction: jest.fn().mockResolvedValue({}),
  };
  const execution = new Execution(
    logger as any, // logger
    config as any, // config
    undefined as any, // prometheus
    undefined as any, // inquirerService
    provider as any, // provider
  );

  return { execution, logger, provider };
};

describe('Execution transaction progress', () => {
  let stderr: jest.SpyInstance;
  let stdout: jest.SpyInstance;

  beforeEach(() => {
    stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderr.mockRestore();
    stdout.mockRestore();
  });

  it('logs the send through the logger', async () => {
    const { execution, logger, provider } = makeExecution();
    const populatedTx = { nonce: 7, gasLimit: 100, maxFeePerGas: 3, maxPriorityFeePerGas: 1 };

    await (execution as any).sendTransactionWithLogging('0xsigned', populatedTx);

    expect(logger.log).toHaveBeenNthCalledWith(1, expect.stringContaining('Sending transaction with nonce 7'));
    expect(provider.sendTransaction).toHaveBeenCalledWith('0xsigned');
    expect(stderr).not.toHaveBeenCalled();
    expect(stdout).not.toHaveBeenCalled();
  });

  it('logs the wait for confirmations through the logger', async () => {
    const { execution, logger, provider } = makeExecution();

    await (execution as any).waitForConfirmation({ hash: '0xabc' });

    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('confirmed 2 times'));
    expect(provider.waitForTransaction).toHaveBeenCalledWith('0xabc', 2, 1000);
    expect(stderr).not.toHaveBeenCalled();
    expect(stdout).not.toHaveBeenCalled();
  });
});
