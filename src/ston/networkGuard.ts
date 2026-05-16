import type { Config } from '../config/env';

export function canExecuteLiveTransactions(config: Config): boolean {
  return (
    config.network === 'testnet' || (config.network === 'mainnet' && config.enableMainnetExecution)
  );
}
