# Researcher citations

The Researchers page reads `data/researchers.json`. Each researcher has independent Google Scholar and OpenAlex counts, profile links, and successful-fetch timestamps. Different databases have different citation coverage; their totals are not interchangeable.

## Activate automatic updates

1. Add `SERPAPI_API_KEY` under GitHub **Settings → Secrets and variables → Actions → New repository secret**. Obtain the key from [SerpApi](https://serpapi.com/manage-api-key). It is needed for weekly Google Scholar updates.
2. Optionally add `OPENALEX_API_KEY` in the same place. Small OpenAlex requests can run without a key; a [free verified key](https://help.openalex.org/api/authentication/) gives a separate, larger allowance.
3. Push these files to the GitHub repository's default branch. Enable GitHub Actions and allow the workflow's `contents: write` permission. Branch rules must allow its data-only commits.
4. In **Actions → Update researcher citations → Run workflow**, select `all` for the first refresh. Inspect its result and confirm the existing Netlify Git integration builds the pushed update.

| Source | Schedule (UTC) | Requests per refresh |
| --- | --- | --- |
| Google Scholar via SerpApi | Monday, 08:17 | One per verified Scholar profile |
| OpenAlex | Daily, 08:43 | One per verified OpenAlex profile |

The two schedules share a concurrency group. Each job checks out the current default branch, commits only `data/researchers.json`, and pushes without force. Updates become visible after Netlify rebuilds. Manual runs can select either source or both; they also consume API quota. SerpApi's [free plan](https://serpapi.com/pricing) currently includes 250 requests/month, sufficient for a weekly refresh of this list.

GitHub schedules can be delayed. Public repositories can have [scheduled workflows disabled after 60 days without repository activity](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule). Check the Actions page if the displayed dates stop advancing.

## Failure behavior

The updater uses only verified profile IDs in the data file. A missing ID is skipped; it never guesses from a name. Missing credentials, HTTP failures, timeouts, invalid counts, and mismatched author IDs preserve the last successful count and timestamp. Successful profiles are saved even when another request fails, and the workflow reports failure so the problem is visible. A returned count of zero is valid. An unchanged count still gets a new successful-fetch timestamp.

No key is stored in the JSON, rendered page, or logs. Set secrets through GitHub's secret settings or the local environment, never in source files.

## Local commands

Node.js 22 or newer is sufficient; there are no package dependencies.

```sh
node scripts/update-citations.mjs --source openalex
node scripts/update-citations.mjs --source scholar
node scripts/update-citations.mjs --source all
node --test tests/update-citations.test.mjs
```

Scholar refreshes require `SERPAPI_API_KEY` in the environment. OpenAlex optionally reads `OPENALEX_API_KEY`. `--data PATH` selects a different JSON file for a manual run. Exit status 1 indicates an incomplete refresh; successfully fetched records have already been saved.

When adding researchers, verify the profile identity and enter its provider ID and public URL. Use `null` for unknown counts and dates. Preserve the date of an existing snapshot until a successful API response replaces it.

## Initial profile verification

The 16 OpenAlex profiles were matched on November 18, 2026 using affiliations, research topics, and representative publications; Murakami and Zhang also match independently confirmed ORCIDs. Public links use `https://openalex.org/authors/A…`.

OpenAlex's records for [Hiroyuki Murakami](https://openalex.org/authors/A5103206976) and [Gan Zhang](https://openalex.org/authors/A5007632206) include unrelated publications. Their badges mark this with a dagger and show the provider's reported count without trying to correct it. Some researchers also have smaller split profiles; only the matched main profile is used, with no aggregation that could double-count citations.

No Google Scholar profile was verified for Geoff Vallis or William M. Gray. Their Scholar bars link to author search and display an unavailable count until a verified ID is added. The other 14 Scholar snapshots retain their original June 5, 2026 date until the first successful SerpApi refresh.
