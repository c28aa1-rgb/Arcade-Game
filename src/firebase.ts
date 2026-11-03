import { initializeApp } from 'firebase/app'
import { getFirestore } from 'firebase/firestore'
import {
  GoogleAuthProvider,
  getAuth,
  onAuthStateChanged,
  signInAnonymously,
  signInWithPopup,
  signOut,
  type User,
} from 'firebase/auth'

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
}

const missingFirebaseKeys = Object.entries(firebaseConfig)
  .filter(([, value]) => !value)
  .map(([key]) => key)

export const isFirebaseConfigured = missingFirebaseKeys.length === 0

export const firebaseConfigError = isFirebaseConfigured
  ? null
  : `Missing Firebase env vars: ${missingFirebaseKeys.join(', ')}`

// Two Firebase app instances on purpose:
//  - the main one carries every visitor's silent (anonymous) session, which
//    owns that browser's player record and poker writes
//  - the developer one carries the Google sign-in, and only it is used for
//    developer actions, so signing in or out of dev mode never costs you the
//    ownership of your own player
export const firebaseApp = isFirebaseConfigured ? initializeApp(firebaseConfig) : null
export const firestore = firebaseApp ? getFirestore(firebaseApp) : null
const playerAuth = firebaseApp ? getAuth(firebaseApp) : null

const developerApp = isFirebaseConfigured ? initializeApp(firebaseConfig, 'developer') : null
export const developerFirestore = developerApp ? getFirestore(developerApp) : null
const developerAuth = developerApp ? getAuth(developerApp) : null

// ---------- player session ----------

let playerSession: Promise<string | null> | null = null

// Resolves with this browser's player uid, signing in silently the first time.
// The uid survives reloads, so the same browser keeps owning its player.
export const ensurePlayerSession = () => {
  if (!playerAuth) {
    return Promise.resolve(null)
  }
  if (!playerSession) {
    playerSession = (async () => {
      await playerAuth.authStateReady()
      if (playerAuth.currentUser) {
        return playerAuth.currentUser.uid
      }
      const credential = await signInAnonymously(playerAuth)
      return credential.user.uid
    })().catch((error) => {
      console.error('Could not start a player session', error)
      playerSession = null
      return null
    })
  }
  return playerSession
}

// The signed proof of this browser's session that the game server checks.
export const getPlayerIdToken = async () => {
  const uid = await ensurePlayerSession()
  return uid && playerAuth?.currentUser ? playerAuth.currentUser.getIdToken() : null
}

// ---------- developer session ----------

// Developer access: a Google sign-in that only one account can pass. The
// Firestore rules check the same address, so this isn't only a page check.
export const DEVELOPER_EMAIL = 'c28aa1@dalton.org'

export const isDeveloperUser = (user: User | null | undefined) =>
  Boolean(user && user.emailVerified && user.email?.toLowerCase() === DEVELOPER_EMAIL)

const signInErrorMessage = (error: unknown) => {
  const code = (error as { code?: string } | null)?.code ?? ''
  if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
    return 'Sign-in was cancelled.'
  }
  if (code === 'auth/popup-blocked') {
    return 'The sign-in window was blocked. Allow pop-ups for this site and try again.'
  }
  if (code === 'auth/unauthorized-domain') {
    return 'This site is not on the Firebase authorized domains list yet.'
  }
  if (code === 'auth/configuration-not-found' || code === 'auth/operation-not-allowed') {
    return 'Google sign-in is not turned on in Firebase yet.'
  }
  return 'Google sign-in failed. Try again.'
}

// Resolves with the developer's email, or rejects with a message to show.
// Anyone else who signs in is signed straight back out.
export const signInAsDeveloper = async () => {
  if (!developerAuth) {
    throw new Error(firebaseConfigError ?? 'Firebase is not configured.')
  }
  await developerAuth.authStateReady()
  if (isDeveloperUser(developerAuth.currentUser)) {
    return developerAuth.currentUser!.email!
  }

  const provider = new GoogleAuthProvider()
  provider.setCustomParameters({ prompt: 'select_account' })

  let user: User
  try {
    user = (await signInWithPopup(developerAuth, provider)).user
  } catch (error) {
    throw new Error(signInErrorMessage(error))
  }

  if (!isDeveloperUser(user)) {
    const email = user.email ?? 'that account'
    await signOut(developerAuth)
    throw new Error(`${email} can't use developer mode.`)
  }
  return user.email!
}

export const signOutDeveloper = async () => {
  if (developerAuth?.currentUser) {
    await signOut(developerAuth)
  }
}

// Sent alongside player requests so the server can show developer extras
// (mine positions, the next hi-lo card, everyone's poker hands).
export const getDeveloperIdToken = async () => {
  if (!developerAuth) {
    return null
  }
  await developerAuth.authStateReady()
  return isDeveloperUser(developerAuth.currentUser) ? developerAuth.currentUser!.getIdToken() : null
}

export const watchDeveloperSession = (onChange: (isDeveloper: boolean) => void) => {
  if (!developerAuth) {
    onChange(false)
    return () => {}
  }
  return onAuthStateChanged(developerAuth, (user) => onChange(isDeveloperUser(user)))
}
