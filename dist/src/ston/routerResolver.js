"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TESTNET_PTON_MASTER_ADDRESS = exports.TESTNET_STON_ROUTER_ADDRESS = void 0;
exports.resolveRouterAddress = resolveRouterAddress;
exports.TESTNET_STON_ROUTER_ADDRESS = 'kQALh-JBBIKK7gr0o4AVf9JZnEsFndqO0qTCyT-D-yBsWk0v';
exports.TESTNET_PTON_MASTER_ADDRESS = 'kQACS30DNoUQ7NfApPvzh7eBmSZ9L4ygJ-lkNWtba8TQT-Px';
function asRecord(value) {
    return value !== null && typeof value === 'object' ? value : {};
}
function findRouterAddress(payload) {
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
async function resolveRouterAddress(config, stonClient) {
    if (config.network === 'testnet') {
        return exports.TESTNET_STON_ROUTER_ADDRESS;
    }
    const routers = await stonClient.getRouters();
    const routerAddress = findRouterAddress(routers);
    if (routerAddress === null) {
        throw new Error('Unable to resolve a STON.fi mainnet router address from API response.');
    }
    return routerAddress;
}
