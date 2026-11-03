// One random source for every game, on the page and on the server: a uniform
// float in [0, 1) from the platform's cryptographic generator.
const buffer = new Uint32Array(1)

export const random = () => {
  crypto.getRandomValues(buffer)
  return buffer[0] / 4294967296
}

export const randomInt = (maxExclusive: number) => Math.floor(random() * maxExclusive)

export const randomSeed = () => {
  crypto.getRandomValues(buffer)
  return buffer[0]
}

// Small deterministic generator, so a Plinko drop decided on the server can be
// replayed frame-for-frame on the page from the same seed.
export const seededRandom = (seed: number) => {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
