"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const sqlite_1 = require("../src/db/sqlite");
const budgetPolicy_1 = require("../src/wallet/budgetPolicy");
let db;
function createService() {
    db = (0, sqlite_1.initializeDatabase)(':memory:');
    return new budgetPolicy_1.BudgetPolicyService(db);
}
(0, vitest_1.afterEach)(() => {
    db?.close();
    db = undefined;
});
(0, vitest_1.describe)('BudgetPolicyService', () => {
    (0, vitest_1.it)('blocks spend when currentSpent + amount > maxBudget', () => {
        const service = createService();
        service.setBudget(1001, 5, 3);
        service.validateAndReserve(1001, 3);
        (0, vitest_1.expect)(() => service.validateAndReserve(1001, 3)).toThrow(budgetPolicy_1.BudgetExceededError);
    });
    (0, vitest_1.it)('allows spend when within budget', () => {
        const service = createService();
        service.setBudget(1002, 5, 3);
        const updated = service.validateAndReserve(1002, 2);
        (0, vitest_1.expect)(updated.currentSpentTon).toBe(2);
        (0, vitest_1.expect)(updated.maxBudgetTon).toBe(5);
    });
    (0, vitest_1.it)('blocks spend when amount > perTradeLimit', () => {
        const service = createService();
        service.setBudget(1003, 5, 1.5);
        (0, vitest_1.expect)(() => service.validateAndReserve(1003, 2)).toThrow(budgetPolicy_1.BudgetExceededError);
    });
    (0, vitest_1.it)('atomically updates spent amount on success', () => {
        const service = createService();
        service.setBudget(1004, 5, 5);
        service.validateAndReserve(1004, 1.25);
        service.validateAndReserve(1004, 2.25);
        const policy = service.getPolicy(1004);
        (0, vitest_1.expect)(policy?.currentSpentTon).toBe(3.5);
    });
    (0, vitest_1.it)('rejects invalid budget definitions', () => {
        const service = createService();
        (0, vitest_1.expect)(() => service.setBudget(1005, 0, 1)).toThrow(budgetPolicy_1.InvalidBudgetPolicyError);
        (0, vitest_1.expect)(() => service.setBudget(1005, 2, 0)).toThrow(budgetPolicy_1.InvalidBudgetPolicyError);
        (0, vitest_1.expect)(() => service.setBudget(1005, 2, 3)).toThrow(budgetPolicy_1.InvalidBudgetPolicyError);
    });
    (0, vitest_1.it)('rejects reservations without a configured policy', () => {
        const service = createService();
        (0, vitest_1.expect)(() => service.validateAndReserve(1006, 1)).toThrow(budgetPolicy_1.BudgetExceededError);
    });
    (0, vitest_1.it)('rejects non-positive reservation amounts', () => {
        const service = createService();
        service.setBudget(1007, 2, 1);
        (0, vitest_1.expect)(() => service.validateAndReserve(1007, 0)).toThrow(budgetPolicy_1.BudgetExceededError);
    });
});
