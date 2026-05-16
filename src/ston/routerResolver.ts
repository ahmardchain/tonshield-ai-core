import type { Config } from '../config/env';
import type { StonClient } from './stonClient';

export const TESTNET_STON_ROUTER_ADDRESS = 'kQALh-JBBIKK7gr0o4AVf9JZnEsFndqO0qTCyT-D-yBsWk0v';
export const TESTNET_PTON_MASTER_ADDRESS = 'kQACS30DNoUQ7NfApPvzh7eBmSZ9L4ygJ-lkNWtba8TQT-Px';

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function findRouterAddress(payload: unknown): string | null {
  const record = asRecord(payload);
  const routers = Array.isArray(record.routers)
    ? record.routers
    : Array.isArray(record.data)
      ? record.data
      : Array.isArray(payload)
        ? payload
        : [];

  for (const router of routers) {
    const routerRecord = asRecord(router);
    const address = routerRecord.address;

    if (typeof address === 'string' && address.length > 0) {
      return address;
    }
  }

  return null;
}

export async function resolveRouterAddress(
  config: Config,
  stonClient: StonClient,
): Promise<string> {
  if (config.network === 'testnet') {
    return TESTNET_STON_ROUTER_ADDRESS;
  }

  const routers = await stonClient.getRouters();
  const routerAddress = findRouterAddress(routers);

  if (routerAddress === null) {
    throw new Error('Unable to resolve a STON.fi mainnet router address from API response.');
  }

  return routerAddress;
}
