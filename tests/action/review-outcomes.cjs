const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const repository = path.resolve(__dirname, '../..');
const bundle = process.env.ACTION_BUNDLE || path.join(repository, 'dist/index.js');
const evidence = process.env.ACTION_EVIDENCE_DIRECTORY;
const cases = [
  'healthy',
  'luna',
  'legacy',
  'zero',
  'zero-threshold',
  'below',
  'exact',
  'sdk-rejection',
  'authentication',
  'timeout',
  'network',
  'invalid-json',
  'invalid-schema',
  'missing',
  'mixed',
  'recovery',
  'missing-license',
  'invalid-license',
];
for (const scenario of cases) {
  test(`generated action: ${scenario}`, { concurrency: false }, () => {
    // Never inherit real provider keys, GitHub tokens, proxies or action inputs.
    const child = spawnSync(process.execPath, [path.join(__dirname, 'fixtures/action-child.cjs'), bundle, scenario], {
      cwd: repository,
      encoding: 'utf8',
      timeout: 20000,
      env: { PATH: process.env.PATH, NODE_OPTIONS: '--max-old-space-size=1024', TZ: 'UTC' },
    });
    assert.ifError(child.error);
    const result = JSON.parse(child.stdout);
    if (evidence) {
      fs.mkdirSync(evidence, { recursive: true });
      fs.writeFileSync(path.join(evidence, scenario + '.json'), JSON.stringify(result, null, 2) + '\n');
    }
    assert.equal(result.harnessError, undefined, JSON.stringify(result));
    assert.deepEqual(result.unexpectedNetwork, []);
    assert.equal(result.licenseCalls, scenario === 'missing-license' ? 0 : 1);
    if (scenario.endsWith('license')) {
      assert.equal(child.status, 1);
      assert.equal(result.requests.length, 0);
      assert.match(result.comments[0].body, /Invalid license key/);
      return;
    }
    assert.equal(result.comments.length, 1);
    assert.ok(
      result.githubCalls.some((call) => call.path.includes('/contents/')),
      'Actual schema retrieval must run'
    );
    const comment = result.comments[0].body;
    const failed = [
      'sdk-rejection',
      'authentication',
      'timeout',
      'network',
      'invalid-json',
      'invalid-schema',
      'missing',
      'mixed',
    ].includes(scenario);
    const thresholdFailed = ['zero', 'below'].includes(scenario);
    assert.equal(child.status, failed || thresholdFailed ? 1 : 0);
    if (failed) {
      assert.match(comment, /Review failed/);
      if (scenario !== 'mixed') {
        assert.doesNotMatch(comment, /Safe|\/100|no consumers/);
      } else {
        assert.match(comment, /85\/100/);
        const failedSection = comment.split('## [').find((section) => section.startsWith('Second event'));
        assert.match(failedSection, /Review failed/);
        assert.doesNotMatch(failedSection, /Safe|\/100/);
      }
      assert.doesNotMatch(
        result.stdout + result.stderr + comment,
        /sk-synthetic-private|private request|synthetic-private-schema/
      );
    } else {
      const score =
        scenario === 'zero' || scenario === 'zero-threshold' ? 0 : scenario === 'below' ? 74 : scenario === 'exact' ? 75 : 85;
      assert.match(comment, new RegExp(score + '/100'));
      assert.doesNotMatch(comment, /Review failed/);
      if (score === 0) {
        assert.match(comment, /Danger/);
        assert.doesNotMatch(comment, /Safe/);
      }
      if (scenario === 'recovery') assert.equal(result.comments[0].method, 'PATCH');
    }
    const request = result.requests[0];
    assert.equal(request.url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(request.body.model, scenario === 'luna' ? 'gpt-5.6-luna' : scenario === 'legacy' ? 'o4-mini' : 'gpt-5.6-terra');
    if (scenario !== 'legacy') {
      assert.equal(request.body.temperature, 1);
      assert.equal(request.body.response_format.type, 'json_schema');
      assert.equal(request.body.response_format.json_schema.strict, true);
      assert.equal(request.body.tools, undefined);
      assert.equal(request.body.tool_choice, undefined);
    }
  });
}
