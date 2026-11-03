// Watches the free-plan daily limits and pushes a phone alert (via ntfy.sh)
// when one gets close. A cron runs check() every 15 minutes; the developer's
// home screen shows the latest numbers.
//
// Cloudflare's limits are account-wide (every Worker on the account shares
// them) and reset at 00:00 UTC. Firestore's reset at midnight Pacific time.
import { DurableObject } from 'cloudflare:workers'
import { getAccessToken, type Env } from './firestore'

export type UsageMeter = {
  key: string
  label: string
  used: number
  limit: number
  // when this meter's count goes back to zero (ms since epoch)
  resetsAt: number
}

export type UsageSnapshot = {
  checkedAt: number
  meters: UsageMeter[]
  // services that couldn't be read, and why
  missing: string[]
}

type AlertState = Record<string, { period: string; level: number }>

const ALERT_LEVELS = [75, 90, 100]
const SNAPSHOT_MAX_AGE_MS = 20 * 60_000

const startOfUtcDay = (now: number) => {
  const date = new Date(now)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
}

// Midnight in Los Angeles, where Firestore's free quota resets.
const startOfPacificDay = (now: number) => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles',
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    })
      .formatToParts(new Date(now))
      .map((part) => [part.type, Number(part.value)]),
  )
  const pacificAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
  const offset = pacificAsUtc - Math.floor(now / 1000) * 1000
  return Date.UTC(parts.year, parts.month - 1, parts.day) - offset
}

const DAY_MS = 24 * 60 * 60_000

const readCloudflareUsage = async (env: Env, now: number): Promise<UsageMeter[]> => {
  if (!env.CF_ANALYTICS_TOKEN) {
    throw new Error('no analytics token set')
  }
  const start = startOfUtcDay(now)
  const query = `query ($account: String!, $start: Time!, $end: Time!) {
    viewer { accounts(filter: { accountTag: $account }) {
      workers: workersInvocationsAdaptive(limit: 10000, filter: { datetime_geq: $start, datetime_lt: $end }) { sum { requests } }
      objects: durableObjectsInvocationsAdaptiveGroups(limit: 10000, filter: { datetime_geq: $start, datetime_lt: $end }) { sum { requests } dimensions { type } }
      storage: durableObjectsPeriodicGroups(limit: 10000, filter: { datetime_geq: $start, datetime_lt: $end }) { sum { rowsRead rowsWritten duration } }
    } }
  }`
  const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query,
      variables: { account: env.CF_ACCOUNT_ID, start: new Date(start).toISOString(), end: new Date(now).toISOString() },
    }),
  })
  type Rows<T> = { sum: T; dimensions?: { type?: string } }[]
  const payload = (await response.json()) as {
    data?: {
      viewer: {
        accounts: {
          workers: Rows<{ requests: number }>
          objects: Rows<{ requests: number }>
          storage: Rows<{ rowsRead: number; rowsWritten: number; duration: number }>
        }[]
      }
    }
    errors?: { message: string }[] | null
  }
  const account = payload.data?.viewer.accounts[0]
  if (!response.ok || !account) {
    throw new Error(payload.errors?.[0]?.message ?? `analytics request failed (${response.status})`)
  }

  const total = <T>(rows: Rows<T>, field: keyof T) => rows.reduce((sum, row) => sum + Number(row.sum[field] ?? 0), 0)
  const resetsAt = start + DAY_MS
  // incoming WebSocket messages (other Workers on the account use them) count
  // 1/20th of a request toward the limit
  const objectRequests = account.objects.reduce(
    (sum, row) => sum + Number(row.sum.requests ?? 0) / (row.dimensions?.type === 'hibernation' ? 20 : 1),
    0,
  )

  return [
    { key: 'cf-requests', label: 'Worker requests', used: total(account.workers, 'requests'), limit: 100_000, resetsAt },
    { key: 'cf-object-requests', label: 'Durable Object requests', used: Math.round(objectRequests), limit: 100_000, resetsAt },
    { key: 'cf-rows-written', label: 'Durable Object writes', used: total(account.storage, 'rowsWritten'), limit: 100_000, resetsAt },
    { key: 'cf-rows-read', label: 'Durable Object reads', used: total(account.storage, 'rowsRead'), limit: 5_000_000, resetsAt },
    { key: 'cf-compute', label: 'Durable Object compute', used: Math.round(total(account.storage, 'duration')), limit: 13_000, resetsAt },
  ]
}

const readFirestoreUsage = async (env: Env, now: number): Promise<UsageMeter[]> => {
  const token = await getAccessToken(env, 'https://www.googleapis.com/auth/monitoring.read')
  if (!token) {
    throw new Error('no Firebase key set')
  }
  const start = startOfPacificDay(now)
  // one bucket covering the whole day so far
  const seconds = Math.max(60, Math.floor((now - start) / 1000))
  const sumMetric = async (metric: string) => {
    const params = new URLSearchParams({
      filter: `metric.type="firestore.googleapis.com/document/${metric}"`,
      'interval.startTime': new Date(now - seconds * 1000).toISOString(),
      'interval.endTime': new Date(now).toISOString(),
      'aggregation.alignmentPeriod': `${seconds}s`,
      'aggregation.perSeriesAligner': 'ALIGN_SUM',
      'aggregation.crossSeriesReducer': 'REDUCE_SUM',
    })
    const response = await fetch(
      `https://monitoring.googleapis.com/v3/projects/${env.FIREBASE_PROJECT_ID}/timeSeries?${params}`,
      { headers: { Authorization: `Bearer ${token}` } },
    )
    if (!response.ok) {
      throw new Error(
        response.status === 403 ? 'the Firebase key is not allowed to read usage' : `usage request failed (${response.status})`,
      )
    }
    const body = (await response.json()) as { timeSeries?: { points?: { value: { int64Value?: string } }[] }[] }
    return (body.timeSeries ?? [])
      .flatMap((series) => series.points ?? [])
      .reduce((sum, point) => sum + Number(point.value.int64Value ?? 0), 0)
  }

  const resetsAt = start + DAY_MS
  const [reads, writes, deletes] = await Promise.all([
    sumMetric('read_ops_count'),
    sumMetric('write_ops_count'),
    sumMetric('delete_ops_count'),
  ])
  return [
    { key: 'fs-reads', label: 'Firebase reads', used: reads, limit: 50_000, resetsAt },
    { key: 'fs-writes', label: 'Firebase writes', used: writes, limit: 20_000, resetsAt },
    { key: 'fs-deletes', label: 'Firebase deletes', used: deletes, limit: 20_000, resetsAt },
  ]
}

const percentOf = (meter: UsageMeter) => (meter.limit > 0 ? (meter.used / meter.limit) * 100 : 0)

const formatCount = (value: number) => Math.round(value).toLocaleString('en-US')

const formatWait = (ms: number) => {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  const hours = Math.floor(minutes / 60)
  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`
}

export class UsageMonitor extends DurableObject<Env> {
  private async push(title: string, message: string, priority: number, tags: string) {
    const topic = this.env.ALERT_NTFY_TOPIC
    if (!topic) {
      return false
    }
    const response = await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
      method: 'POST',
      headers: { Title: title, Priority: String(priority), Tags: tags },
      body: message,
    })
    return response.ok
  }

  // Reads every meter, stores the result, and alerts on any meter that has
  // crossed 75%, 90% or 100% since its last alert in the same day.
  async check(): Promise<UsageSnapshot> {
    const now = Date.now()
    const meters: UsageMeter[] = []
    const missing: string[] = []
    const sources: [string, () => Promise<UsageMeter[]>][] = [
      ['Cloudflare', () => readCloudflareUsage(this.env, now)],
      ['Firebase', () => readFirestoreUsage(this.env, now)],
    ]
    for (const [name, read] of sources) {
      try {
        meters.push(...(await read()))
      } catch (error) {
        missing.push(`${name}: ${error instanceof Error ? error.message : 'could not read usage'}`)
      }
    }

    const snapshot: UsageSnapshot = { checkedAt: now, meters, missing }
    await this.ctx.storage.put('snapshot', snapshot)

    const alerted = (await this.ctx.storage.get<AlertState>('alerted')) ?? {}
    const lines: string[] = []
    let topLevel = 0
    for (const meter of meters) {
      const percent = percentOf(meter)
      const level = [...ALERT_LEVELS].reverse().find((entry) => percent >= entry) ?? 0
      const period = String(meter.resetsAt)
      const previous = alerted[meter.key]?.period === period ? alerted[meter.key].level : 0
      if (level > previous) {
        alerted[meter.key] = { period, level }
        topLevel = Math.max(topLevel, level)
        lines.push(
          `${meter.label}: ${Math.floor(percent)}% (${formatCount(meter.used)} of ${formatCount(meter.limit)}). Resets in ${formatWait(meter.resetsAt - now)}.`,
        )
      }
    }

    if (lines.length > 0) {
      const title = topLevel >= 100 ? 'UES Casino hit a free daily limit' : `UES Casino is at ${topLevel}% of a free daily limit`
      try {
        await this.push(title, lines.join('\n'), topLevel >= 100 ? 5 : topLevel >= 90 ? 4 : 3, topLevel >= 100 ? 'rotating_light' : 'warning')
      } catch (error) {
        console.error('usage alert failed to send', error)
      }
      await this.ctx.storage.put('alerted', alerted)
    }
    return snapshot
  }

  // The latest numbers, refreshed if the last check is stale.
  async latest(): Promise<UsageSnapshot> {
    const snapshot = await this.ctx.storage.get<UsageSnapshot>('snapshot')
    if (snapshot && Date.now() - snapshot.checkedAt < SNAPSHOT_MAX_AGE_MS) {
      return snapshot
    }
    return this.check()
  }

  async sendTest() {
    const sent = await this.push(
      'UES Casino alerts are on',
      "You'll get a message here when the casino reaches 75%, 90% or 100% of a free daily limit.",
      3,
      'white_check_mark',
    )
    return { ok: sent, error: sent ? undefined : 'No alert topic is set, or ntfy.sh did not accept the message.' }
  }
}
