import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const token = process.env.APIFY_TOKEN ?? '';
const apiBase = (process.env.GITHUB_ACTIONS === 'true' ? 'https://api.apify.com/v2' : (process.env.APIFY_API_BASE_URL || 'https://api.apify.com/v2')).replace(/\/$/, '');
const runDeadlineMs = 5 * 60 * 60 * 1000;

function safe(value) {
  return String(value).replaceAll(token || '\0', '[REDACTED]').replace(/[\r\n]/g, ' ');
}

function fail(message) {
  throw new Error(safe(message));
}

function parseBoolean(value, name) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  fail(`${name} must be true or false`);
}

function parseNumber(value, name, min, max, integer = false) {
  const number = Number(value);
  if (!String(value).trim() || !Number.isFinite(number) || number < min || number > max || (integer && !Number.isInteger(number))) {
    fail(`${name} must be ${integer ? 'an integer' : 'a number'} from ${min} to ${max}`);
  }
  return number;
}

function pageUrl(value, name) {
  let url;
  try { url = new URL(value); } catch { fail(`${name} must be a public HTTP(S) URL`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) fail(`${name} must be an HTTP(S) URL without credentials`);
  return value;
}

function parseInput() {
  if (!token.trim()) fail('apify-token is required');
  if (token.includes('\n') || token.includes('\r')) fail('apify-token must be one line');
  const lines = (process.env.INPUT_URLS || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length || lines.length > 200) fail('urls must contain 1 to 200 nonempty lines');
  const parsed = lines.map((line, index) => {
    const parts = line.split('|').map((part) => part.trim());
    if (parts.length > 2 || parts.some((part) => !part)) fail(`invalid urls line ${index + 1}: expected URL or URL|BASELINE_URL`);
    return { url: pageUrl(parts[0], `target on line ${index + 1}`), baseline: parts[1] ? pageUrl(parts[1], `baseline on line ${index + 1}`) : null };
  });
  const seen = new Set();
  parsed.forEach((item, index) => {
    if (seen.has(item.url)) fail(`duplicate target URL on line ${index + 1}: list each target page once so every result maps to its own baseline`);
    seen.add(item.url);
  });
  if (parsed.some((item) => Boolean(item.baseline) !== Boolean(parsed[0].baseline))) {
    fail('all urls lines must either have a baseline or have none; the Actor requires one baseline per target');
  }
  const threshold = parseNumber(process.env.INPUT_THRESHOLD ?? '0.5', 'threshold', 0, 100);
  const width = parseNumber(process.env.INPUT_VIEWPORT_WIDTH ?? '1366', 'viewport-width', 1, 10000, true);
  const device = { 390: 'mobile', 768: 'tablet', 1366: 'desktop', 1440: 'laptop' }[width];
  if (!device) fail('viewport-width must match an Actor device preset: 390, 768, 1366, or 1440');
  const fullPage = parseBoolean(process.env.INPUT_FULL_PAGE ?? 'true', 'full-page');
  const failOnDiff = parseBoolean(process.env.INPUT_FAIL_ON_DIFF ?? 'true', 'fail-on-diff');
  const timeoutSecs = parseNumber(process.env.INPUT_TIMEOUT_SECONDS ?? '45', 'timeout-seconds', 5, 180, true);
  const actorInput = {
    urls: parsed.map((item) => item.url),
    mode: fullPage ? 'fullPage' : 'viewport',
    device,
    changedThresholdPercent: threshold,
    timeoutSecs,
  };
  if (parsed[0].baseline) actorInput.baselineUrls = parsed.map((item) => item.baseline);
  return { parsed, threshold, failOnDiff, actorInput };
}

async function apiJson(relativePath, options = {}) {
  const response = await fetch(`${apiBase}${relativePath}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) fail(`Apify API returned HTTP ${response.status} for ${options.method || 'GET'} ${relativePath.split('?')[0]}`);
  try { return await response.json(); } catch { fail('Apify API returned invalid JSON'); }
}

async function actorRows(actorInput) {
  const started = await apiJson('/acts/lintlab~screenshot-diff/runs', { method: 'POST', body: JSON.stringify(actorInput) });
  const runId = started?.data?.id;
  if (!runId || !/^[A-Za-z0-9]+$/.test(runId)) fail('Apify did not return a valid run ID');
  const deadline = Date.now() + runDeadlineMs;
  let run = started.data;
  while (!['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT'].includes(run.status)) {
    if (Date.now() > deadline) fail('Actor run did not finish within 5 hours');
    run = (await apiJson(`/actor-runs/${runId}`))?.data;
    if (!run || typeof run.status !== 'string') fail('Apify returned an invalid run status');
    if (!['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT'].includes(run.status)) {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
  if (run.status !== 'SUCCEEDED') fail(`Actor run ended with status ${run.status}`);
  const datasetId = run.defaultDatasetId;
  if (!datasetId || !/^[A-Za-z0-9]+$/.test(datasetId)) fail('Apify did not return a valid dataset ID');
  const rows = await apiJson(`/datasets/${datasetId}/items?format=json&limit=200`);
  if (!Array.isArray(rows)) fail('Apify dataset response was not an array');
  return rows;
}

function normalize(rows, parsed, threshold) {
  if (rows.length !== parsed.length) fail(`Actor returned ${rows.length} rows for ${parsed.length} URLs`);
  const queues = new Map();
  parsed.forEach((item, index) => {
    if (!queues.has(item.url)) queues.set(item.url, []);
    queues.get(item.url).push(index);
  });
  const results = Array(parsed.length);
  for (const row of rows) {
    if (!row || typeof row !== 'object') fail('Actor returned an invalid dataset row');
    const queue = queues.get(row?.url);
    if (!queue?.length) fail('Actor returned an unexpected or duplicate URL row');
    const item = parsed[queue.shift()];
    const diffPercent = row?.diff?.diffPercent;
    if (!row.error && item.baseline && (!Number.isFinite(diffPercent) || diffPercent < 0 || diffPercent > 100)) {
      fail(`Actor returned no valid diff percentage for ${item.url}`);
    }
    results[parsed.indexOf(item)] = {
      url: safe(item.url),
      baseline: item.baseline ? safe(item.baseline) : null,
      diffPercent: Number.isFinite(diffPercent) ? diffPercent : null,
      passed: !row.error && (!item.baseline || diffPercent <= threshold),
      screenshotUrl: row.screenshotUrl ? safe(row.screenshotUrl) : null,
      diffImageUrl: row.diff?.diffImageUrl ? safe(row.diff.diffImageUrl) : null,
      error: row.error ? safe(row.error) : null,
    };
  }
  return results;
}

function markdownText(value) {
  return safe(value ?? '—').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('|', '&#124;');
}

function markdownLink(label, value) {
  if (!value) return '—';
  let url;
  try { url = new URL(value); } catch { return '—'; }
  if (!['http:', 'https:'].includes(url.protocol)) return '—';
  return `[${label}](${url.href.replace(/[()]/g, (match) => match === '(' ? '%28' : '%29')})`;
}

async function emit(results, threshold) {
  const failedCount = results.filter((item) => item.baseline && !item.error && !item.passed).length;
  const maxDiffPercent = Math.max(0, ...results.map((item) => item.diffPercent ?? 0));
  const summary = [
    '## Visual regression check',
    '',
    `Threshold: ${threshold}%`,
    '',
    '| URL | Baseline | Diff % | Result | Screenshot | Diff image |',
    '| --- | --- | ---: | --- | --- | --- |',
    ...results.map((item) => `| ${markdownText(item.url)} | ${markdownText(item.baseline)} | ${item.diffPercent === null ? '—' : item.diffPercent} | ${item.error ? `ERROR: ${markdownText(item.error)}` : item.passed ? 'PASS' : 'FAIL'} | ${markdownLink('Screenshot', item.screenshotUrl)} | ${markdownLink('Diff', item.diffImageUrl)} |`),
    '',
  ].join('\n');
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
  if (process.env.GITHUB_OUTPUT) {
    const delimiter = `lintlab_${randomBytes(16).toString('hex')}`;
    await appendFile(process.env.GITHUB_OUTPUT, `max-diff-percent=${maxDiffPercent}\nfailed-count=${failedCount}\nresults-json<<${delimiter}\n${JSON.stringify(results)}\n${delimiter}\n`);
  }
  return { failedCount, maxDiffPercent };
}

async function downloadDiffs(results) {
  const directory = process.env.INPUT_DIFF_IMAGES_DIR?.trim();
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  for (const [index, item] of results.entries()) {
    if (!item.diffImageUrl) continue;
    let url;
    try { url = new URL(item.diffImageUrl); } catch { fail('Actor returned an invalid diff image URL'); }
    if (!['http:', 'https:'].includes(url.protocol)) fail('Actor returned an invalid diff image URL');
    const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) fail(`Diff image download returned HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 25 * 1024 * 1024) fail('Diff image exceeded 25 MB download limit');
    await writeFile(path.join(directory, `diff-${String(index + 1).padStart(3, '0')}.png`), bytes);
  }
}

async function main() {
  const { parsed, threshold, failOnDiff, actorInput } = parseInput();
  const results = normalize(await actorRows(actorInput), parsed, threshold);
  const { failedCount, maxDiffPercent } = await emit(results, threshold);
  await downloadDiffs(results);
  const errors = results.filter((item) => item.error);
  if (errors.length) fail(`Actor returned ${errors.length} error row(s): ${errors.map((item) => `${item.url}: ${item.error}`).join('; ')}`);
  if (failedCount && failOnDiff) fail(`${failedCount} URL(s) exceeded the ${threshold}% diff threshold (maximum ${maxDiffPercent}%)`);
  console.log(`Visual regression check complete: ${results.length} URL(s), ${failedCount} above threshold, maximum ${maxDiffPercent}%.`);
}

main().catch((error) => { console.error(`Visual regression check failed: ${safe(error?.message ?? error)}`); process.exitCode = 1; });
