#!/usr/bin/env node
// Find where people overruled the bot's guts labels. Every label added or
// removed by a person on an issue the bot labelled is a disagreement with Jev,
// and the labels such an issue ends up with are a human-confirmed answer.
// See docs/dev/issue-guts-tuning.md.
//
//   node .github/guts/corrections.mjs [--since 2026-10-01] [--emit]
//
// --emit prints the confirmed issues missing from labelled.json, in its format,
// ready to be reviewed and merged in. Needs GITHUB_TOKEN (or GH_TOKEN).

import {readFileSync} from 'node:fs'
import {parseArgs} from 'node:util'
import {pathToFileURL} from 'node:url'
import {areas, github, LABEL_PREFIX} from './classify.mjs'

const isBot = actor => actor?.type === 'Bot' || /\[bot\]$/.test(actor?.login ?? '')
const area = label => label.slice(LABEL_PREFIX.length)

/**
 * Replays an issue's label events. Returns what the bot chose, what the issue
 * carries now, and what people added or removed on top of the bot.
 */
export function diffLabelEvents(events, currentLabels) {
  const bot = new Set()
  const added = new Set()
  const removed = new Set()
  for (const e of events) {
    if (!['labeled', 'unlabeled'].includes(e.event) || !e.label?.name.startsWith(LABEL_PREFIX)) continue
    const a = area(e.label.name)
    if (isBot(e.actor)) {
      if (e.event === 'labeled') bot.add(a)
      continue
    }
    if (e.event === 'labeled') {
      removed.delete(a)
      if (!bot.has(a)) added.add(a)
    } else {
      added.delete(a)
      if (bot.has(a)) removed.add(a)
    }
  }
  const now = currentLabels.filter(l => l.startsWith(LABEL_PREFIX)).map(area)
  return {bot: [...bot], now, added: [...added], removed: [...removed]}
}

async function listIssuesSince(since) {
  const issues = []
  for (let page = 1; ; page++) {
    const batch = await github(`issues?state=all&since=${since}&per_page=100&page=${page}`)
    // `since` filters on last update; keep only issues opened after it.
    issues.push(...batch.filter(i => !i.pull_request && i.created_at >= since))
    if (batch.length < 100) return issues
  }
}

async function main() {
  const defaultSince = new Date(Date.now() - 180 * 864e5).toISOString().slice(0, 10)
  const {values} = parseArgs({options: {since: {type: 'string', default: defaultSince}, emit: {type: 'boolean'}}})

  const labelled = JSON.parse(readFileSync(new URL('labelled.json', import.meta.url), 'utf8'))
  const perArea = {}
  const unknown = new Set()
  const confirmed = {}
  let labelledByBot = 0
  let corrected = 0

  for (const issue of await listIssuesSince(values.since)) {
    const events = await github(`issues/${issue.number}/events?per_page=100`)
    const d = diffLabelEvents(events, issue.labels.map(l => l.name))
    for (const a of d.now) if (!(a in areas)) unknown.add(a)
    if (d.bot.length === 0) continue
    labelledByBot++
    if (d.added.length === 0 && d.removed.length === 0) continue
    corrected++
    for (const a of d.added) (perArea[a] ??= {added: 0, removed: 0}).added++
    for (const a of d.removed) (perArea[a] ??= {added: 0, removed: 0}).removed++
    console.log(`#${issue.number} ${issue.title.slice(0, 70)}`)
    console.log(`    bot: ${d.bot.join(', ')}  →  now: ${d.now.join(', ') || '(none)'}`)
    if (!(issue.number in labelled)) {
      confirmed[issue.number] = {
        title: issue.title,
        split: issue.number % 3 === 0 ? 'holdout' : 'train',
        areas: d.now.length ? d.now : ['other'],
        note: 'Confirmed by a person overruling the bot.',
      }
    }
  }

  console.log(`\nSince ${values.since}: ${labelledByBot} issues labelled by the bot, ${corrected} corrected by people.`)
  if (labelledByBot) console.log(`Correction rate: ${((100 * corrected) / labelledByBot).toFixed(0)} %`)
  console.log('\nCorrections per area (added = Jev missed it, removed = Jev was wrong):')
  for (const [a, {added, removed}] of Object.entries(perArea)) console.log(`  ${a.padEnd(26)} added ${added}, removed ${removed}`)
  if (unknown.size) console.log(`\nLabels in use with no entry in areas.json: ${[...unknown].join(', ')}`)
  if (values.emit) console.log('\n' + JSON.stringify(confirmed, null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
