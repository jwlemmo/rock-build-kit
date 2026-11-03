// Pure-unit tests for the launch_workflow WorkflowEntry path builder and the
// upsert_metric_value partition resolver (no network).
// Run: node test/verify-launch-upsert.mjs
import { buildWorkflowEntryPath } from '../dist/tools/workflows.js';
import { resolvePartitions } from '../dist/tools/metrics.js';

let pass = 0, fail = 0;
const check = (name, cond) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
};

// --- buildWorkflowEntryPath ---
check('no attrs → bare path', buildWorkflowEntryPath(391) === 'Workflows/WorkflowEntry/391');
check('empty attrs → bare path', buildWorkflowEntryPath(391, {}) === 'Workflows/WorkflowEntry/391');
{
  const p = buildWorkflowEntryPath(391, { TestNote: 'a b', Flag: true, N: 5 });
  check('attrs ride the query string', p.startsWith('Workflows/WorkflowEntry/391?'));
  check('string value URL-encoded', p.includes('TestNote=a%20b'));
  check('boolean → True/False', p.includes('Flag=True'));
  check('number stringified', p.includes('N=5'));
}
{
  const p = buildWorkflowEntryPath(7, { 'K&x': 'v=1' });
  check('key and value fully encoded', p === 'Workflows/WorkflowEntry/7?K%26x=v%3D1');
}

// --- resolvePartitions ---
const CAMPUS_SERVICE = [
  { Id: 10, Label: 'Campus', EntityTypeId: 67, IsRequired: true },
  { Id: 11, Label: 'Service', EntityTypeId: 54, IsRequired: false },
];

{
  const { resolved, problems } = resolvePartitions(CAMPUS_SERVICE, { Campus: 2 });
  check('required by label resolves', problems.length === 0);
  check('campus entity id mapped', resolved.some((p) => p.metricPartitionId === 10 && p.entityId === 2));
  check('optional partition auto-null', resolved.some((p) => p.metricPartitionId === 11 && p.entityId === null));
  check('every metric partition covered', resolved.length === 2);
}
{
  const { problems } = resolvePartitions(CAMPUS_SERVICE, undefined);
  check('missing required partition is a problem', problems.length === 1 && /required/.test(problems[0]));
}
{
  const { problems } = resolvePartitions(CAMPUS_SERVICE, { campus: 2 });
  check('label match is case-insensitive', problems.length === 0);
}
{
  const { resolved, problems } = resolvePartitions(CAMPUS_SERVICE, { '10': 3 });
  check('numeric key matches by partition Id', problems.length === 0 && resolved.some((p) => p.metricPartitionId === 10 && p.entityId === 3));
}
{
  const { problems } = resolvePartitions(CAMPUS_SERVICE, { Campus: 2, '10': 3 });
  check('duplicate coverage rejected', problems.some((p) => /more than once/.test(p)));
}
{
  const { problems } = resolvePartitions(CAMPUS_SERVICE, { Bogus: 1 });
  check('unknown partition lists available', problems.some((p) => /no partition "Bogus"/.test(p) && /Campus/.test(p)));
}
{
  const { problems } = resolvePartitions(CAMPUS_SERVICE, { Campus: 'two' });
  check('non-numeric EntityId rejected', problems.some((p) => /numeric EntityId/.test(p)));
}
{
  const DEFAULT_ONLY = [{ Id: 5, Label: null, EntityTypeId: null, IsRequired: false }];
  const { resolved, problems } = resolvePartitions(DEFAULT_ONLY, undefined);
  check('default partition handled automatically', problems.length === 0 && resolved.length === 1 && resolved[0].entityId === null);
}
{
  const { resolved, problems } = resolvePartitions([], undefined);
  check('unpartitioned metric → empty, no problems', problems.length === 0 && resolved.length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
