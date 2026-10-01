# Visual Regression Check (screenshot diff)

Catch layout breaks before they merge. This GitHub Action screenshots your pull request's preview deployment, compares it pixel by pixel with production, and fails the check when more than your threshold of the page changed. The job summary shows a PASS/FAIL table with links to each screenshot and diff image.

There is no browser to install and no baseline images to commit: the captures run in the cloud on the [lintlab/screenshot-diff](https://apify.com/lintlab/screenshot-diff) Apify Actor, and the Action only needs `node`, which every GitHub-hosted runner has.

## Quick start

1. Create a free account at [apify.com](https://apify.com), copy your API token from Settings → API & Integrations, and save it as the repository secret `APIFY_TOKEN`.
2. Add a workflow step:

```yaml
- uses: lintlab/visual-regression-action@v1
  with:
    apify-token: ${{ secrets.APIFY_TOKEN }}
    urls: |
      https://preview.example.com/|https://www.example.com/
      https://preview.example.com/pricing|https://www.example.com/pricing
    threshold: '0.5'
```

Each line is `TARGET_URL|BASELINE_URL`. Leave out the baseline (`TARGET_URL` alone) to capture screenshots without comparing.

## Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `apify-token` | Yes | — | Apify API token. |
| `urls` | Yes | — | 1–200 lines of `URL` or `URL\|BASELINE_URL`; every line in a run must use the same form, and each target URL may appear once. |
| `threshold` | No | `0.5` | Maximum changed-pixel percentage (0–100). |
| `viewport-width` | No | `1366` | Exact Actor device preset width: `390`, `768`, `1366`, or `1440` CSS pixels. |
| `full-page` | No | `true` | `true` for full page; `false` for viewport. |
| `fail-on-diff` | No | `true` | Exit nonzero when a comparison exceeds `threshold`. |
| `timeout-seconds` | No | `45` | Per-page Actor timeout (5–180 seconds). |
| `diff-images-dir` | No | empty | Download diff PNGs to this directory for artifact upload. |

## Outputs

| Output | Description |
| --- | --- |
| `max-diff-percent` | Maximum measured `diff.diffPercent`; `0` for capture-only runs. |
| `failed-count` | Number of measured comparisons above `threshold`. |
| `results-json` | JSON array of `{url, baseline, diffPercent, passed, screenshotUrl, diffImageUrl, error}`. |

## Cost

The Action is free and MIT-licensed. The Actor it calls is billed to your Apify account per event:

- **$0.004 per successful capture**
- **$0.002 per computed diff**

So one page compared against its baseline costs $0.006 in Actor events, plus the Apify platform usage of the run. A PR check covering 10 pages costs about $0.06 in events. Failed captures are not charged as captures.

## When a free tool is better

Be honest with yourself about which setup you have:

- **Your pages run locally or in CI already.** If your test suite can start the app, [Playwright's `toHaveScreenshot()`](https://playwright.dev/docs/test-snapshots) is free, runs on your own runner, and works for pages behind a login. Use that.
- **You want baseline images reviewed in git.** Tools like [BackstopJS](https://github.com/garris/BackstopJS) keep reference images in your repo and give you an approval workflow.

This Action fits when you have **public** URLs (a preview deploy and production, or staging and production) and want a check in a few lines of YAML, with no browser on the runner and no baseline images to maintain.

## Example: PR preview vs. production

[`examples/pr-preview.yml`](examples/pr-preview.yml) compares a pull request's preview URL (from a repository variable) with production and uploads the diff images as an artifact. Its `workflow_dispatch` job compares `example.com` with itself at `threshold: '0'`, which is a quick way to check that your token works.

## Limits and security

- Public pages only. The Actor refuses private, loopback and link-local addresses, honors `robots.txt`, and does not log in, so password-protected previews won't work.
- Dynamic content (ads, clocks, carousels) shows up as changed pixels. Raise `threshold` or compare stable pages.
- Your token is masked in the logs and sent only in the `Authorization` header to `api.apify.com`, never in a URL.

## Support

Open an issue in this repository, or email hello@lintlab.dev. More tools: [lintlab.dev](https://lintlab.dev/).

Built by **lintlab** — small, reliable data tools. Tested before release.
