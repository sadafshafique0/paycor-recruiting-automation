#!/usr/bin/env node
// Thin CLI over src/intake/addCandidates.js. Ported as-is from
// Paycor-Outreach-Toolkit/cli/add-candidates.js.
//
// Usage:
//   node cli/add-candidates.js --pipeline hr-director-101 --ids 111,222,333
//   node cli/add-candidates.js --pipeline hr-director-101 --json '[{"id":"111","name":"Jane Doe"}]'

const { paths } = require('../src/config');
const { addCandidates } = require('../src/intake/addCandidates');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const value = argv[i + 1];
      args[key] = value;
      i++;
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.pipeline) {
    console.error('Usage: node cli/add-candidates.js --pipeline <key> (--ids 111,222,333 | --json \'[{"id":"111","name":"Jane Doe"}]\')');
    process.exitCode = 1;
    return;
  }

  let entries;
  if (args.json) {
    entries = JSON.parse(args.json);
  } else if (args.ids) {
    entries = args.ids.split(',').map((id) => ({ id: id.trim(), name: '(unknown name)' }));
  } else {
    console.error('Provide either --ids or --json');
    process.exitCode = 1;
    return;
  }

  const { stateFile } = paths();
  const result = addCandidates(stateFile, entries, args.pipeline);

  console.log(`Added ${result.added.length} candidate(s) to pipeline "${args.pipeline}": ${result.added.join(', ') || '(none)'}`);
  if (result.skipped.length) {
    console.log(`Skipped ${result.skipped.length}:`);
    for (const s of result.skipped) console.log(`  - ${s.id}: ${s.reason}`);
  }
  console.log('These will be sent First Contact on the next scheduled run (cli/run-daily.js, or the dashboard\'s "Run now").');
}

if (require.main === module) main();
