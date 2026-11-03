// Verifies Firebase ID tokens (the page's silent player session, and the
// developer's Google session) against Google's public signing keys.
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose'

const GOOGLE_KEYS = createRemoteJWKSet(
  new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'),
)

export type FirebaseClaims = JWTPayload & {
  sub: string
  email?: string
  email_verified?: boolean
  firebase?: { sign_in_provider?: string }
}

export const verifyFirebaseToken = async (token: string, projectId: string): Promise<FirebaseClaims | null> => {
  try {
    const { payload } = await jwtVerify(token, GOOGLE_KEYS, {
      issuer: `https://securetoken.google.com/${projectId}`,
      audience: projectId,
    })
    return typeof payload.sub === 'string' && payload.sub ? (payload as FirebaseClaims) : null
  } catch {
    return null
  }
}

export const isDeveloperClaims = (claims: FirebaseClaims | null, developerEmail: string) =>
  Boolean(
    claims &&
      claims.email_verified === true &&
      claims.email?.toLowerCase() === developerEmail.toLowerCase() &&
      claims.firebase?.sign_in_provider === 'google.com',
  )
