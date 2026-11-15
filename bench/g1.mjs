// G-1 bench (D-26): 100 000 transactions, each evaluated against 20 rules, one `evaluate` call per
// transaction, with the default limits (this shape reaches none of them, so none is raised). It
// measures 100 000 SEPARATE evaluations: the single-evaluation form over a collection (G-1 of the
// plan, `maxInstances`) is measured again in Task 9R1, when collections exist. Run `npm run build`,
// then:
//
//   node bench/g1.mjs [transactions] [rules]
//
// It prints the machine, the Node version, the total time, the time per transaction, the throughput
// and the peak memory (resident set). The figure belongs to the machine and the Node version it prints: copy all three.
import os from 'node:os';
import { PPEEngine, computeRuleChecksum } from '../dist/index.js';

const TRANSACTIONS = Number(process.argv[2] ?? 100_000);
const RULES = Number(process.argv[3] ?? 20);

const model = {
  name: 'rate',
  version: '1.0.0',
  validateParams: (params) => ({ valid: typeof params?.rate === 'number' }),
  calculate: (input, _rule, params) => input.amount * params.rate,
};

const plugin = {
  name: 'bench',
  version: '1.0.0',
  onInit: (context) => context.modelRegistry.register(model),
};

function rule(index) {
  const base = {
    id: `r${index}`,
    version: 1,
    model: 'rate',
    params: { rate: 0.01 + index / 1000 },
    priority: 100 + index,
    effectiveFrom: '2024-01-01T00:00:00.000Z',
    effectiveUntil: null,
    tags: [],
  };
  return { ...base, checksum: computeRuleChecksum(base) };
}

const rules = Array.from({ length: RULES }, (_, index) => rule(index));
const engine = new PPEEngine({
  plugins: [plugin],
  dsls: [],
  strict: false,
});

const input = (index) => ({
  requestId: `tx-${index}`,
  data: { amount: 100 + (index % 50) },
  meta: { tenantId: 'bench', effectiveDate: '2025-06-01' },
});

// Warm up, so the figure is not the cost of compiling.
for (let index = 0; index < 500; index += 1) await engine.evaluate(rules, input(-index - 1));

const started = process.hrtime.bigint();
let value = 0;
for (let index = 0; index < TRANSACTIONS; index += 1) {
  const result = await engine.evaluate(rules, input(index));
  value += result.value;
}
const seconds = Number(process.hrtime.bigint() - started) / 1e9;

console.log(
  JSON.stringify(
    {
      transactions: TRANSACTIONS,
      rulesPerTransaction: RULES,
      seconds: Number(seconds.toFixed(2)),
      msPerTransaction: Number(((seconds * 1000) / TRANSACTIONS).toFixed(3)),
      transactionsPerSecond: Math.round(TRANSACTIONS / seconds),
      peakMemoryMiB: Math.round(process.resourceUsage().maxRSS / 1024),
      checksum: value,
      node: process.version,
      machine: `${os.cpus()[0]?.model ?? 'unknown cpu'}, ${os.cpus().length} cores, ${Math.round(os.totalmem() / 2 ** 30)} GiB, ${os.platform()} ${os.arch()}`,
    },
    null,
    2,
  ),
);
