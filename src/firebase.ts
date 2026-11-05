import { initializeApp } from 'firebase/app'
import type { Firestore } from 'firebase/firestore'
import type { Auth, User } from 'firebase/auth'

// Firebase's sign-in and database libraries are most of the site's download
// (about 320 KB of 800 KB), so they load in the background the first time
// they're needed instead of holding up the first screen.
let authSdk: Promise<typeof import('firebase/auth')> | null = null
let firestoreSdk: Promise<typeof import('firebase/firestore')> | null = null
export const loadAuthSdk = () => (authSdk ??= import('firebase/auth'))
export const loadFirestoreSdk = () => (firestoreSdk ??= import('firebase/firestore'))

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
const developerApp = isFirebaseConfigured ? initializeApp(firebaseConfig, 'developer') : null

const getPlayerAuth = async (): Promise<Auth | null> => (firebaseApp ? (await loadAuthSdk()).getAuth(firebaseApp) : null)
const getDeveloperAuth = async (): Promise<Auth | null> =>
  developerApp ? (await loadAuthSdk()).getAuth(developerApp) : null

// Auth is set up first so the database sends that session with every request.
export const getPlayerDb = async (): Promise<Firestore | null> => {
  if (!firebaseApp) {
    return null
  }
  await getPlayerAuth()
  return (await loadFirestoreSdk()).getFirestore(firebaseApp)
}

export const getDeveloperDb = async (): Promise<Firestore | null> => {
  if (!developerApp) {
    return null
  }
  await getDeveloperAuth()
  return (await loadFirestoreSdk()).getFirestore(developerApp)
}

// ---------- player session ----------

let playerSession: Promise<string | null> | null = null

// Resolves with this browser's player uid, signing in silently the first time.
// The uid survives reloads, so the same browser keeps owning its player.
export const ensurePlayerSession = () => {
  if (!firebaseApp) {
    return Promise.resolve(null)
  }
  if (!playerSession) {
    playerSession = (async () => {
      const playerAuth = (await getPlayerAuth())!
      await playerAuth.authStateReady()
      if (playerAuth.currentUser) {
        return playerAuth.currentUser.uid
      }
      const credential = await (await loadAuthSdk()).signInAnonymously(playerAuth)
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
  const playerAuth = await getPlayerAuth()
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
  const developerAuth = await getDeveloperAuth()
  if (!developerAuth) {
    throw new Error(firebaseConfigError ?? 'Firebase is not configured.')
  }
  const { GoogleAuthProvider, signInWithPopup, signOut } = await loadAuthSdk()
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
  const developerAuth = await getDeveloperAuth()
  if (developerAuth?.currentUser) {
    await (await loadAuthSdk()).signOut(developerAuth)
  }
}

// Sent alongside player requests so the server can show developer extras
// (mine positions, the next hi-lo card, everyone's poker hands).
export const getDeveloperIdToken = async () => {
  const developerAuth = await getDeveloperAuth()
  if (!developerAuth) {
    return null
  }
  await developerAuth.authStateReady()
  return isDeveloperUser(developerAuth.currentUser) ? developerAuth.currentUser!.getIdToken() : null
}

export const watchDeveloperSession = (onChange: (isDeveloper: boolean) => void) => {
  if (!developerApp) {
    onChange(false)
    return () => {}
  }
  let stopped = false
  let unsubscribe = () => {}
  void (async () => {
    const developerAuth = (await getDeveloperAuth())!
    const { onAuthStateChanged } = await loadAuthSdk()
    if (!stopped) {
      unsubscribe = onAuthStateChanged(developerAuth, (user) => onChange(isDeveloperUser(user)))
    }
  })()
  return () => {
    stopped = true
    unsubscribe()
  }
}
