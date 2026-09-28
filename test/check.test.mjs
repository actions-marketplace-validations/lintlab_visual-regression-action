import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const token = 'mock-secret-token';

async function scenario({ rows, status = 200, input = {}, diffImages = false }) {
  const calls = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    calls.push({ method: request.method, url: request.url, authorization: request.headers.authorization, body });
    response.setHeader('content-type', 'application/json');
    if (request.url === '/v2/acts/lintlab~screenshot-diff/runs') {
      response.statusCode = status;
      response.end(status === 200 ? JSON.stringify({ data: { id: 'run123', status: 'RUNNING' } }) : JSON.stringify({ error: `unauthorized ${token}` }));
    } else if (request.url === '/v2/actor-runs/run123') {
      response.end(JSON.stringify({ data: { id: 'run123', status: 'SUCCEEDED', defaultDatasetId: 'dataset123' } }));
    } else if (request.url === '/v2/datasets/dataset123/items?format=json&limit=200') {
      response.end(JSON.stringify(rows).replaceAll('http://mock/diff.png', `${base}/diff.png`));
    } else if (request.url === '/diff.png') {
      response.setHeader('content-type', 'image/png');
      response.end(Buffer.from('fake-png'));
    } else {
      response.statusCode = 404;
      response.end('{}');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = await mkdtemp(path.join(root, 'test', '.tmp-'));
  const output = path.join(dir, 'output');
  const summary = path.join(dir, 'summary');
  const env = {
    ...process.env,
    GITHUB_ACTIONS: 'false',
    GITHUB_OUTPUT: output,
    GITHUB_STEP_SUMMARY: summary,
    APIFY_API_BASE_URL: `${base}/v2`,
    APIFY_TOKEN: token,
    INPUT_URLS: 'https://preview.example.com|https://example.com',
    INPUT_THRESHOLD: '0.5',
    INPUT_VIEWPORT_WIDTH: '1366',
    INPUT_FULL_PAGE: 'true',
    INPUT_FAIL_ON_DIFF: 'true',
    INPUT_TIMEOUT_SECONDS: '45',
    INPUT_DIFF_IMAGES_DIR: diffImages ? path.join(dir, 'diffs') : '',
    ...input,
  };
  try {
    const result = await new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(root, 'scripts', 'check.mjs')], { cwd: root, env });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
    return {
      ...result,
      calls,
      output: await readFile(output, 'utf8').catch(() => ''),
      summary: await readFile(summary, 'utf8').catch(() => ''),
      diffs: diffImages ? await readdir(path.join(dir, 'diffs')).catch(() => []) : [],
    };
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function row(diffPercent, diffImageUrl = 'https://example.com/diff.png') {
  return {
    url: 'https://preview.example.com',
    screenshotUrl: 'https://example.com/screenshot.png',
    diff: { baseline: 'https://example.com', diffPercent, diffImageUrl },
  };
}

test('pass case maps Actor input, outputs, summary, and optional image download', async () => {
  const result = await scenario({ rows: [row(0.2, 'http://mock/diff.png')], diffImages: true });
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.calls[0].body), {
    urls: ['https://preview.example.com'],
    mode: 'fullPage',
    device: 'desktop',
    changedThresholdPercent: 0.5,
    timeoutSecs: 45,
    baselineUrls: ['https://example.com'],
  });
  assert.ok(result.calls.filter((call) => call.url.startsWith('/v2/')).every((call) => call.authorization === `Bearer ${token}`));
  assert.equal(result.calls.find((call) => call.url === '/diff.png').authorization, undefined);
  assert.ok(result.calls.every((call) => !call.url.includes(token)));
  assert.match(result.output, /max-diff-percent=0\.2/);
  assert.match(result.output, /failed-count=0/);
  assert.match(result.summary, /\| PASS \| \[Screenshot\]/);
  assert.match(result.summary, /\[Diff\]/);
  assert.deepEqual(result.diffs, ['diff-001.png']);
});

test('over-threshold case fails and records result', async () => {
  const result = await scenario({ rows: [row(1.25)] });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /exceeded the 0\.5% diff threshold/);
  assert.match(result.output, /failed-count=1/);
  assert.match(result.summary, /\| FAIL \|/);
});

test('Actor error row fails clearly even when fail-on-diff is false', async () => {
  const result = await scenario({ rows: [{ url: 'https://preview.example.com', error: 'disallowed by robots.txt', screenshotUrl: null }], input: { INPUT_FAIL_ON_DIFF: 'false' } });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /disallowed by robots\.txt/);
  assert.match(result.summary, /ERROR: disallowed by robots\.txt/);
});

test('duplicate target URLs fail before any paid Actor run starts', async () => {
  const result = await scenario({
    rows: [],
    input: { INPUT_URLS: 'https://example.com/|https://example.org/\nhttps://example.com/|https://httpbin.org/get' },
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /duplicate target URL on line 2/);
  assert.equal(result.calls.length, 0);
});

test('HTTP 401 fails without printing response body or token', async () => {
  const result = await scenario({ rows: [], status: 401 });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /HTTP 401/);
  assert.ok(!`${result.stdout}${result.stderr}`.includes(token));
});

test('token stays out of stdout and stderr, including an error row echo', async () => {
  const result = await scenario({ rows: [{ url: 'https://preview.example.com', error: `bad token ${token}` }] });
  assert.equal(result.code, 1);
  assert.ok(!`${result.stdout}${result.stderr}`.includes(token));
  assert.match(result.stderr, /\[REDACTED\]/);
});
