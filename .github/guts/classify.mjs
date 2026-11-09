#!/usr/bin/env node
// Classify GitHub issues into "guts" areas with Jev, TypeSafe's System One
// model (https://docs.typesafe.ai/api): one yes/no question per area, each
// answered with its own probability, so an issue can land in several areas.
// See docs/dev/issue-guts.md.
//
//   node .github/guts/classify.mjs [--threshold 0.7] [--out results.json] <issue>...
//
// Needs TYPESAFE_API_KEY, and GITHUB_TOKEN (or GH_TOKEN) to read the issues.
// Under Actions it also writes `labels=` to $GITHUB_OUTPUT and a table to
// $GITHUB_STEP_SUMMARY; locally it only prints, so it is safe for dry runs.

import {readFileSync, appendFileSync, writeFileSync} from 'node:fs'
import {parseArgs} from 'node:util'
import {pathToFileURL} from 'node:url'

const SYSTEMONE_URL = 'https://api.typesafe.ai/v1/systemone'
const MODEL = process.env.GUTS_MODEL ?? 'jev-latest'
// The API reports tokens, not money; this is TypeSafe's published input rate.
const USD_PER_INPUT_TOKEN = 0.042 / 1e6
const MAX_ATTEMPTS = 4
const REPO = process.env.GITHUB_REPOSITORY ?? 'Open-Resin-Alliance/DragonFruit'
// Jev's context is 32k tokens; leave room for the area questions.
const MAX_BODY_CHARS = 60_000

export const LABEL_PREFIX = 'guts: '
export const FALLBACK_AREA = 'other'
export const DEFAULT_THRESHOLD = 0.7

// name → {description, within?}. `within` names a broader area this one sits
// inside: when both are picked, only the narrower one is kept.
export const areas = JSON.parse(readFileSync(new URL('areas.json', import.meta.url), 'utf8'))
for (const [area, {within}] of Object.entries(areas)) {
  if (within && !(within in areas)) throw new Error(`areas.json: "${area}" is within unknown area "${within}"`)
}
// Question keys must be identifiers; area names have spaces and slashes.
const keyOf = area => area.replace(/[^a-z0-9]+/gi, '_')

export function requireEnv(...names) {
  for (const name of names) if (process.env[name]) return process.env[name]
  throw new Error(`missing ${names.join(' or ')}`)
}

export async function github(path) {
  const res = await fetch(`https://api.github.com/repos/${REPO}/${path}`, {
    headers: {
      authorization: `Bearer ${requireEnv('GITHUB_TOKEN', 'GH_TOKEN')}`,
      accept: 'application/vnd.github+json',
    },
  })
  if (!res.ok) throw new Error(`GitHub ${res.status} for ${path}: ${await res.text()}`)
  return res.json()
}

export async function fetchIssue(number) {
  const issue = await github(`issues/${number}`)
  // The issues API also serves pull requests; their bodies aren't bug reports.
  if (issue.pull_request) throw new Error(`#${number} is a pull request, not an issue`)
  return issue
}

// "DragonFruit 0.1.15 (beta) — sin/slice-baking-crash @ a6deb763b": the branch
// name is noise to a reader but reads as a topic, so keep only the version.
const stripBuildNames = body => body.replace(/(DragonFruit \S+(?: \(\w+\))?) — \S+ @ [0-9a-f]{7,}/g, '$1')

// The issue forms in .github/ISSUE_TEMPLATE render each question as a "### "
// heading followed by the answer. These headings appear in one form each, the
// same ones the title-prefix step in issue-guts.yml checks.
const FORM_MARKERS = ['### Steps to reproduce', '### What problem are you trying to solve?']
// Answers that tell Jev nothing: GitHub's filler for a blank field, and the
// dropdown choices that mean "not applicable".
const EMPTY_ANSWERS = new Set(['_No response_', 'None', 'Not printer-related', 'Not export-related'])
const FORM_NOTE =
  'The report was filled in with an issue form: `form` maps each question to the reporter\'s answer, and unanswered questions are left out. ' +
  'The answer about where in DragonFruit it happened is the reporter\'s own guess: a useful hint, but often incomplete or off, because reporters pick the screen they were on rather than every part that is broken. Judge each area from what the report describes. ' +
  'The printer brand, printer model and file format say what the reporter was using; on their own they do not make the problem specific to that printer or format.'

/** question → answer for an issue written with one of the forms, or null. */
export function parseForm(body) {
  if (!FORM_MARKERS.some(marker => body.includes(marker))) return null
  const form = {}
  for (const section of body.split(/^### /m).slice(1)) {
    const newline = section.indexOf('\n')
    if (newline === -1) continue
    const question = section.slice(0, newline).trim()
    const answer = section.slice(newline + 1).trim()
    if (answer && !EMPTY_ANSWERS.has(answer)) form[question] = answer
  }
  return form
}

/** What Jev reads about the issue: the form's answers if it has them, else the raw body. */
function describeIssue(issue) {
  const body = stripBuildNames(issue.body ?? '').slice(0, MAX_BODY_CHARS)
  const form = parseForm(body)
  return form ? {title: issue.title, form, about_the_form: FORM_NOTE} : {title: issue.title, body}
}

/** Asks Jev about every area at once; returns {probabilities, model, cost}. */
export async function classify(issue) {
  const questions = {}
  const named = Object.keys(areas).filter(area => area !== FALLBACK_AREA)
  for (const [area, {description}] of Object.entries(areas)) {
    questions[keyOf(area)] = {
      type: 'noul',
      instructions:
        area === FALLBACK_AREA
          ? `Is a substantial part of this bug report about something none of these areas of DragonFruit covers?\n${named.map(a => `- ${a}: ${areas[a].description}`).join('\n')}`
          : `Does this bug report concern the "${area}" area of DragonFruit?`,
      criteria: {
        true: description,
        false: `The report is not about this area, or only mentions it in passing.`,
      },
    }
  }

  const request = JSON.stringify({
    model: MODEL,
    // The report is untrusted, but Jev can only answer the questions asked.
    state: {
      application: 'DragonFruit, a desktop slicer for resin (MSLA) 3D printers',
      ...describeIssue(issue),
    },
    questions,
  })

  let res
  for (let attempt = 1; ; attempt++) {
    res = await fetch(SYSTEMONE_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${requireEnv('TYPESAFE_API_KEY')}`,
        'content-type': 'application/json',
      },
      body: request,
    })
    // 429 rate limited, 529 overloaded: both worth waiting out.
    if (![429, 529].includes(res.status) || attempt === MAX_ATTEMPTS) break
    await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** attempt))
  }
  if (!res.ok) throw new Error(`TypeSafe ${res.status}: ${await res.text()}`)
  const reply = await res.json()

  const probabilities = {}
  for (const area of Object.keys(areas)) {
    const p = reply.answers?.[keyOf(area)]?.noul
    if (typeof p !== 'number') throw new Error(`no answer for "${area}": ${JSON.stringify(reply)}`)
    probabilities[area] = p
  }
  const tokens = reply.usage?.input_tokens
  const cost = typeof tokens === 'number' ? tokens * USD_PER_INPUT_TOKEN : undefined
  return {probabilities, model: reply.model, cost}
}

/**
 * The areas an issue gets at a threshold: those at or above it, minus any area
 * a narrower picked one sits within; the fallback when none reaches it.
 */
export function pickAreas(probabilities, threshold) {
  const picked = Object.keys(probabilities).filter(area => probabilities[area] >= threshold)
  const covered = new Set(picked.map(area => areas[area]?.within).filter(Boolean))
  const kept = picked.filter(area => !covered.has(area))
  return kept.length ? kept : [FALLBACK_AREA]
}

async function main() {
  const {values, positionals} = parseArgs({
    allowPositionals: true,
    options: {threshold: {type: 'string', default: String(DEFAULT_THRESHOLD)}, out: {type: 'string'}},
  })
  const threshold = Number(values.threshold)
  if (!(threshold > 0 && threshold < 1) || positionals.length === 0) {
    console.error('usage: classify.mjs [--threshold 0.7] [--out results.json] <issue>...')
    process.exit(2)
  }

  const summary = []
  const results = {}
  let labels = []
  for (const arg of positionals) {
    const issue = await fetchIssue(Number(arg))
    const {probabilities, model, cost} = await classify(issue)
    const ranked = Object.entries(probabilities).sort(([, a], [, b]) => b - a)
    labels = pickAreas(probabilities, threshold).map(area => LABEL_PREFIX + area)
    results[issue.number] = {title: issue.title, model, probabilities}
    const price = cost === undefined ? '?' : cost.toFixed(6)

    console.log(`#${issue.number} ${issue.title}`)
    for (const [area, p] of ranked) console.log(`  ${p >= threshold ? '✔' : ' '} ${p.toFixed(3)}  ${area}`)
    console.log(`  → ${labels.join(', ')}  (${model}, $${price})\n`)

    summary.push(
      `### #${issue.number} ${issue.title}`,
      '',
      `**Labels:** ${labels.join(', ')} · threshold ${threshold} · ${model} · $${price}`,
      '',
      '| Area | p |',
      '| --- | ---: |',
      ...ranked.map(([area, p]) => `| ${p >= threshold ? `**${area}**` : area} | ${p.toFixed(3)} |`),
      '',
    )
  }

  // Raw probabilities, for evaluate.mjs --run.
  if (values.out) writeFileSync(values.out, JSON.stringify(results, null, 2) + '\n')
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary.join('\n') + '\n')
  // Only meaningful for a single issue, which is how the workflow calls it.
  if (process.env.GITHUB_OUTPUT && positionals.length === 1) {
    appendFileSync(process.env.GITHUB_OUTPUT, `labels=${labels.join(',')}\n`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
