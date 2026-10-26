#!/usr/bin/env node
// Upload links for issue attachments (#597): one upload-only FileBrowser
// Quantum share per issue, at /issues/<n>/ in the "uploads" source. Anyone
// with the link can upload; only developers with an account can read.
// See docs/dev/upload-service.md.
//
//   node .github/uploads/uploads.mjs open <issue>    prints the link (reuses an existing one)
//   node .github/uploads/uploads.mjs close <issue>   deletes the link and the files
//
// Needs UPLOADS_URL (the service's public address) and UPLOADS_TOKEN (an API
// token of the bot account). Under Actions it also writes `url=` (open) or
// `deleted=` (close) to $GITHUB_OUTPUT.

import {appendFileSync} from 'node:fs'

const SOURCE = 'uploads'

function requireEnv(name) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set`)
  return value
}

async function api(method, path, body) {
  const res = await fetch(new URL(path, requireEnv('UPLOADS_URL')), {
    method,
    headers: {
      Authorization: `Bearer ${requireEnv('UPLOADS_TOKEN')}`,
      ...(body && {'Content-Type': 'application/json'}),
    },
    body: body && JSON.stringify(body),
  })
  const text = await res.text()
  return {status: res.status, ok: res.ok, json: () => JSON.parse(text), text}
}

function fail(what, res) {
  throw new Error(`${what}: HTTP ${res.status} ${res.text}`)
}

const folderOf = issue => `/issues/${issue}/`

async function sharesFor(issue) {
  const query = new URLSearchParams({source: SOURCE, path: folderOf(issue)})
  const res = await api('GET', `/api/share?${query}`)
  if (!res.ok) fail('listing shares', res)
  return res.json()
}

async function open(issue) {
  // The browser uploads in chunks, and a chunk cannot land in a folder that
  // does not exist yet. 409: it already does.
  const query = new URLSearchParams({source: SOURCE, path: folderOf(issue), isDir: 'true'})
  const mkdir = await api('POST', `/api/resources?${query}`)
  if (!mkdir.ok && mkdir.status !== 409) fail('creating folder', mkdir)

  const existing = (await sharesFor(issue)).find(s => s.shareType === 'upload')
  if (existing) return existing.shareURL

  const res = await api('POST', '/api/share', {
    source: SOURCE,
    path: folderOf(issue),
    shareType: 'upload',
    title: `DragonFruit #${issue}`,
    description: 'Only the DragonFruit developers can see what you upload here.',
  })
  if (!res.ok) fail('creating share', res)
  return res.json().shareURL
}

async function close(issue) {
  let deleted = false
  // Deleting the share is what makes the link answer 404; deleting only the
  // folder would leave a live link that fails every upload.
  for (const {hash} of await sharesFor(issue)) {
    const res = await api('DELETE', `/api/share?${new URLSearchParams({hash})}`)
    if (!res.ok) fail(`deleting share ${hash}`, res)
    deleted = true
  }
  const query = new URLSearchParams({source: SOURCE, path: folderOf(issue)})
  const res = await api('DELETE', `/api/resources?${query}`)
  if (res.ok) deleted = true
  else if (res.status !== 404) fail('deleting files', res)
  return deleted
}

const [command, issue] = process.argv.slice(2)
if (!['open', 'close'].includes(command) || !/^\d+$/.test(issue ?? '')) {
  console.error('usage: uploads.mjs open|close <issue>')
  process.exit(2)
}

const output = command === 'open' ? `url=${await open(issue)}` : `deleted=${await close(issue)}`
console.log(output)
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${output}\n`)
