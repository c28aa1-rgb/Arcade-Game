// Everything the page reads or writes in Firestore, behind plain async calls.
// The Firestore library itself only downloads the first time one of these
// runs (see firebase.ts), so it never delays the first screen.
import { getDeveloperDb, getPlayerDb, loadFirestoreSdk } from './firebase'

type StoredData = Record<string, unknown> & { id?: string }

// The whole player list, or just the richest `top` players.
export const loadPlayers = async (top?: number): Promise<StoredData[]> => {
  const db = await getPlayerDb()
  if (!db) {
    return []
  }
  const { collection, getDocs, limit, orderBy, query } = await loadFirestoreSdk()
  const players = collection(db, 'players')
  const snapshot = await getDocs(top ? query(players, orderBy('bankroll', 'desc'), limit(top)) : players)
  return snapshot.docs.map((entry) => entry.data() as StoredData)
}

// Merges fields into a player record. Someone else's record goes through the
// developer's Google session, the only one the rules let touch it.
export const savePlayerProfile = async (playerId: string, fields: Record<string, unknown>, asDeveloper: boolean) => {
  const db = asDeveloper ? await getDeveloperDb() : await getPlayerDb()
  if (!db) {
    return
  }
  const { doc, setDoc } = await loadFirestoreSdk()
  await setDoc(doc(db, 'players', playerId), fields, { merge: true })
}

type Unsubscribe = () => void

// Live-watches a document; `onData` gets null once it's deleted. The returned
// function stops watching, even if the library hasn't finished loading.
export const watchDocument = (
  path: [string, ...string[]],
  onData: (data: StoredData | null) => void,
  { asDeveloper = false, onError }: { asDeveloper?: boolean; onError?: (error: unknown) => void } = {},
): Unsubscribe => {
  let stopped = false
  let unsubscribe: Unsubscribe = () => {}
  void (async () => {
    const db = asDeveloper ? await getDeveloperDb() : await getPlayerDb()
    const { doc, onSnapshot } = await loadFirestoreSdk()
    if (!db || stopped) {
      return
    }
    unsubscribe = onSnapshot(
      doc(db, ...path),
      (snapshot) => onData(snapshot.exists() ? (snapshot.data() as StoredData) : null),
      (error) => onError?.(error),
    )
  })()
  return () => {
    stopped = true
    unsubscribe()
  }
}

// Live-watches every document in a collection.
export const watchCollection = (
  path: [string, ...string[]],
  onDocs: (docs: { id: string; data: StoredData }[]) => void,
  { asDeveloper = false, onError }: { asDeveloper?: boolean; onError?: (error: unknown) => void } = {},
): Unsubscribe => {
  let stopped = false
  let unsubscribe: Unsubscribe = () => {}
  void (async () => {
    const db = asDeveloper ? await getDeveloperDb() : await getPlayerDb()
    const { collection, onSnapshot } = await loadFirestoreSdk()
    if (!db || stopped) {
      return
    }
    unsubscribe = onSnapshot(
      collection(db, ...path),
      (snapshot) => onDocs(snapshot.docs.map((entry) => ({ id: entry.id, data: entry.data() as StoredData }))),
      (error) => onError?.(error),
    )
  })()
  return () => {
    stopped = true
    unsubscribe()
  }
}
