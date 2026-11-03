import { initializeApp } from 'firebase/app'
import { getFirestore } from 'firebase/firestore'
import { GoogleAuthProvider, getAuth, onAuthStateChanged, signInWithPopup, signOut, type User } from 'firebase/auth'

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

export const firebaseApp = isFirebaseConfigured ? initializeApp(firebaseConfig) : null
export const firestore = firebaseApp ? getFirestore(firebaseApp) : null

// Developer access: a Google sign-in that only one account can pass.
export const DEVELOPER_EMAIL = 'c28aa1@dalton.org'

export const firebaseAuth = firebaseApp ? getAuth(firebaseApp) : null

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
  if (!firebaseAuth) {
    throw new Error(firebaseConfigError ?? 'Firebase is not configured.')
  }
  if (isDeveloperUser(firebaseAuth.currentUser)) {
    return firebaseAuth.currentUser!.email!
  }

  const provider = new GoogleAuthProvider()
  provider.setCustomParameters({ hd: 'dalton.org', login_hint: DEVELOPER_EMAIL, prompt: 'select_account' })

  let user: User
  try {
    user = (await signInWithPopup(firebaseAuth, provider)).user
  } catch (error) {
    throw new Error(signInErrorMessage(error))
  }

  if (!isDeveloperUser(user)) {
    const email = user.email ?? 'that account'
    await signOut(firebaseAuth)
    throw new Error(`${email} can't use developer mode. Only ${DEVELOPER_EMAIL} can.`)
  }
  return user.email!
}

export const signOutDeveloper = async () => {
  if (firebaseAuth?.currentUser) {
    await signOut(firebaseAuth)
  }
}

export const watchDeveloperSession = (onChange: (isDeveloper: boolean) => void) => {
  if (!firebaseAuth) {
    onChange(false)
    return () => {}
  }
  return onAuthStateChanged(firebaseAuth, (user) => onChange(isDeveloperUser(user)))
}
