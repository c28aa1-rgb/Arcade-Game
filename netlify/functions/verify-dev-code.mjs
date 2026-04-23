const json = (statusCode, body) => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  },
  body: JSON.stringify(body),
})

export async function handler(event) {
  if (event.httpMethod !== 'POST') {
    return json(405, { success: false, error: 'Method not allowed' })
  }

  const expectedCode = process.env.DEV_MODE_PASSWORD?.trim()

  if (!expectedCode) {
    return json(500, { success: false, error: 'Dev access is not configured on the server' })
  }

  try {
    const payload = JSON.parse(event.body || '{}')
    const submittedCode = typeof payload.code === 'string' ? payload.code.trim() : ''

    if (!submittedCode) {
      return json(400, { success: false, error: 'Enter a code first' })
    }

    if (submittedCode !== expectedCode) {
      return json(401, { success: false, error: 'Incorrect code' })
    }

    return json(200, { success: true })
  } catch {
    return json(400, { success: false, error: 'Invalid request payload' })
  }
}
