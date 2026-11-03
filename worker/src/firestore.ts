// Minimal Firestore REST client. Writes use the Firebase service account (so
// they bypass the security rules, which stop browsers from touching money);
// reads of public data work without it.
import { importPKCS8, SignJWT } from 'jose'

export type Env = {
  PLAYERS: DurableObjectNamespace<import('./vault').PlayerVault>
  TABLES: DurableObjectNamespace<import('./table').PokerTable>
  FIREBASE_PROJECT_ID: string
  DEVELOPER_EMAIL: string
  ALLOWED_ORIGINS: string
  FIREBASE_SERVICE_ACCOUNT?: string
  // how long a poker table may sit without any action before it closes
  POKER_IDLE_MINUTES?: string
  // usage alerts (see usage.ts): the Cloudflare account, a read-only
  // analytics token, and the ntfy.sh topic the alerts are pushed to
  CF_ACCOUNT_ID: string
  CF_ANALYTICS_TOKEN?: string
  ALERT_NTFY_TOPIC?: string
  MONITOR: DurableObjectNamespace<import('./usage').UsageMonitor>
}

type FirestoreValue =
  | { nullValue: null }
  | { booleanValue: boolean }
  | { integerValue: string }
  | { doubleValue: number }
  | { stringValue: string }
  | { arrayValue: { values?: FirestoreValue[] } }
  | { mapValue: { fields?: Record<string, FirestoreValue> } }

export const toFirestoreValue = (value: unknown): FirestoreValue => {
  if (value === null || value === undefined) {
    return { nullValue: null }
  }
  if (typeof value === 'boolean') {
    return { booleanValue: value }
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value }
  }
  if (typeof value === 'string') {
    return { stringValue: value }
  }
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(toFirestoreValue) } }
  }
  return { mapValue: { fields: toFirestoreFields(value as Record<string, unknown>) } }
}

export const toFirestoreFields = (object: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(object)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, toFirestoreValue(value)]),
  )

export const fromFirestoreValue = (value: FirestoreValue): unknown => {
  if ('nullValue' in value) return null
  if ('booleanValue' in value) return value.booleanValue
  if ('integerValue' in value) return Number(value.integerValue)
  if ('doubleValue' in value) return value.doubleValue
  if ('stringValue' in value) return value.stringValue
  if ('arrayValue' in value) return (value.arrayValue.values ?? []).map(fromFirestoreValue)
  if ('mapValue' in value) return fromFirestoreFields(value.mapValue.fields ?? {})
  return null
}

export const fromFirestoreFields = (fields: Record<string, FirestoreValue>) =>
  Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, fromFirestoreValue(value)]))

type ServiceAccount = { client_email: string; private_key: string }

const DATASTORE_SCOPE = 'https://www.googleapis.com/auth/datastore'
const cachedTokens = new Map<string, { value: string; expiresAt: number }>()

export const getAccessToken = async (env: Env, scope = DATASTORE_SCOPE) => {
  if (!env.FIREBASE_SERVICE_ACCOUNT) {
    return null
  }
  const cachedToken = cachedTokens.get(scope)
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.value
  }

  const account = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT) as ServiceAccount
  const key = await importPKCS8(account.private_key, 'RS256')
  const now = Math.floor(Date.now() / 1000)
  const assertion = await new SignJWT({ scope })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(account.client_email)
    .setAudience('https://oauth2.googleapis.com/token')
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(key)

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  })
  const payload = (await response.json()) as { access_token?: string; expires_in?: number }
  if (!response.ok || !payload.access_token) {
    throw new Error(`Service account sign-in failed (${response.status})`)
  }

  cachedTokens.set(scope, { value: payload.access_token, expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1000 })
  return payload.access_token
}

const documentsRoot = (env: Env) =>
  `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents`

export const documentName = (env: Env, path: string) =>
  `projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${path}`

export const canWriteFirestore = (env: Env) => Boolean(env.FIREBASE_SERVICE_ACCOUNT)

export const getDocument = async (env: Env, path: string): Promise<Record<string, unknown> | null> => {
  const token = await getAccessToken(env)
  const response = await fetch(`${documentsRoot(env)}/${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (response.status === 404) {
    return null
  }
  if (!response.ok) {
    throw new Error(`Firestore read failed (${response.status})`)
  }
  const body = (await response.json()) as { fields?: Record<string, FirestoreValue> }
  return fromFirestoreFields(body.fields ?? {})
}

export type FirestoreWrite =
  | { kind: 'merge'; path: string; data: Record<string, unknown> }
  | { kind: 'set'; path: string; data: Record<string, unknown> }
  | { kind: 'delete'; path: string }

// Applies several writes atomically. 'merge' only touches the given fields.
export const commitWrites = async (env: Env, writes: FirestoreWrite[]) => {
  const token = await getAccessToken(env)
  if (!token || writes.length === 0) {
    return false
  }

  const body = {
    writes: writes.map((write) => {
      if (write.kind === 'delete') {
        return { delete: documentName(env, write.path) }
      }
      const update = { name: documentName(env, write.path), fields: toFirestoreFields(write.data) }
      return write.kind === 'merge'
        ? { update, updateMask: { fieldPaths: Object.keys(write.data).map((key) => `\`${key}\``) } }
        : { update }
    }),
  }

  const response = await fetch(
    `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents:commit`,
    { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
  )
  if (!response.ok) {
    throw new Error(`Firestore write failed (${response.status}): ${(await response.text()).slice(0, 200)}`)
  }
  return true
}
