const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const repository = path.resolve(__dirname, '../..');
const bundle = process.env.ACTION_BUNDLE || path.join(repository, 'dist/index.js');
const cases = [];
for (const ref of ['base', 'head'])
  for (const fault of [
    '401',
    '403',
    '404',
    '503',
    'network',
    'timeout',
    'directory',
    'missing',
    'encoding',
    'truncated',
    'malformed',
    'base64',
    'utf8',
    'empty',
  ])
    cases.push(`source-${ref}-${fault}`);
cases.push(
  'source-modified',
  'source-added',
  'source-removed',
  'source-renamed-change',
  'source-renamed-same',
  'source-rename-ambiguous',
  'source-unknown',
  'source-mixed',
  'source-commentwrite',
  'source-recovered',
  'source-zero',
  'source-zero-threshold'
);
for (const scenario of cases) {
  test(`shipped source acquisition: ${scenario}`, { concurrency: false }, () => {
    const child = spawnSync(process.execPath, [path.join(__dirname, 'fixtures/action-child.cjs'), bundle, scenario], {
      cwd: repository,
      encoding: 'utf8',
      timeout: 20000,
      env: { PATH: process.env.PATH, NODE_OPTIONS: '--max-old-space-size=1024', TZ: 'UTC' },
    });
    assert.ifError(child.error);
    const result = JSON.parse(child.stdout);
    if (process.env.ACTION_EVIDENCE_DIRECTORY) {
      fs.mkdirSync(process.env.ACTION_EVIDENCE_DIRECTORY, { recursive: true });
      fs.writeFileSync(
        path.join(process.env.ACTION_EVIDENCE_DIRECTORY, scenario + '.json'),
        JSON.stringify(result, null, 2) + '\n'
      );
    }
    assert.equal(result.harnessError, undefined, JSON.stringify(result));
    assert.deepEqual(result.unexpectedNetwork, []);
    assert.equal(result.licenseCalls, 1);
    const healthy = [
      'source-modified',
      'source-added',
      'source-renamed-change',
      'source-renamed-same',
      'source-recovered',
      'source-zero',
      'source-zero-threshold',
    ].includes(scenario);
    assert.equal(child.status, healthy && scenario !== 'source-zero' ? 0 : 1);
    const comment = result.comments[0]?.body || result.commentAttempts[0]?.body;
    assert.ok(comment);
    if (!healthy) {
      assert.match(comment, /Review failed/);
      if (scenario === 'source-mixed') {
        assert.equal(result.requests.length, 1);
        assert.match(comment, /100\/100/);
        const section = comment.split('## [').find((s) => s.includes('events%2FInventoryAdjusted%2Fschema.json'));
        assert.match(section, /Review failed/);
        assert.doesNotMatch(section, /Safe|\/100/);
      } else {
        assert.equal(result.requests.length, 0);
        assert.doesNotMatch(comment, /Safe|\/100/);
      }
      assert.doesNotMatch(
        result.stdout + result.stderr + JSON.stringify(result.requests) + comment,
        /SECRET_SOURCE_FIXTURE|Could not retrieve content|This is a directory/
      );
      if (scenario === 'source-commentwrite') {
        assert.equal(result.comments.length, 0);
        assert.ok(
          result.stdout.indexOf('schema review(s) could not be completed') < result.stdout.indexOf('comment publication failed')
        );
      } else {
        assert.match(result.stdout, /schema review\(s\) could not be completed/);
      }
    } else {
      assert.equal(result.requests.length, 1);
      const score = scenario.startsWith('source-zero') ? 0 : 100;
      assert.match(comment, new RegExp(`${score}/100`));
      if (score === 0) {
        assert.match(comment, /Danger/);
        assert.doesNotMatch(comment, /Safe/);
      }
      if (scenario === 'source-recovered') assert.equal(result.comments[0].method, 'PATCH');
      const reads = result.githubCalls.filter((call) => call.path.includes('/contents/'));
      if (scenario === 'source-added') {
        assert.equal(reads.length, 1);
        assert.equal(reads[0].ref, 'head');
        assert.match(result.requests[0].body.messages[1].content, /added[\s\S]*absent/i);
      }
      if (scenario.startsWith('source-renamed')) {
        assert.equal(reads.length, 2);
        assert.match(reads[0].path, /events\/OldEvent\/schema.json$/);
        assert.equal(reads[0].ref, 'base');
        assert.match(reads[1].path, /events\/InventoryAdjusted\/schema.json$/);
        assert.equal(reads[1].ref, 'head');
        assert.match(result.requests[0].body.messages[1].content, /renamed/);
      }
    }
  });
}
