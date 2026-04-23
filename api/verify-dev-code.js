export default function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ success: false, error: 'Method not allowed' })
  }

  const expectedCode = process.env.DEV_MODE_PASSWORD?.trim()

  if (!expectedCode) {
    return res.status(500).json({
      success: false,
      error: 'Dev access is not configured on the server',
    })
  }

  const submittedCode = typeof req.body?.code === 'string' ? req.body.code.trim() : ''

  if (!submittedCode) {
    return res.status(400).json({ success: false, error: 'Enter a code first' })
  }

  if (submittedCode !== expectedCode) {
    return res.status(401).json({ success: false, error: 'Incorrect code' })
  }

  res.setHeader('Cache-Control', 'no-store')
  return res.status(200).json({ success: true })
}
