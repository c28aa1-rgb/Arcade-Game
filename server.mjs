import { createReadStream, existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'

const port = Number(process.env.PORT || 3000)
const distDir = join(process.cwd(), 'dist')

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
}

const sendJson = (response, statusCode, body) => {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  response.end(JSON.stringify(body))
}

const serveFile = (response, filePath) => {
  const extension = extname(filePath)

  response.writeHead(200, {
    'Content-Type': mimeTypes[extension] || 'application/octet-stream',
  })

  createReadStream(filePath).pipe(response)
}

const handleVerifyDevCode = async (request, response) => {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST')
    sendJson(response, 405, { success: false, error: 'Method not allowed' })
    return
  }

  const expectedCode = process.env.DEV_MODE_PASSWORD?.trim()

  if (!expectedCode) {
    sendJson(response, 500, { success: false, error: 'Dev access is not configured on the server' })
    return
  }

  let rawBody = ''

  for await (const chunk of request) {
    rawBody += chunk
  }

  try {
    const payload = JSON.parse(rawBody || '{}')
    const submittedCode = typeof payload.code === 'string' ? payload.code.trim() : ''

    if (!submittedCode) {
      sendJson(response, 400, { success: false, error: 'Enter a code first' })
      return
    }

    if (submittedCode !== expectedCode) {
      sendJson(response, 401, { success: false, error: 'Incorrect code' })
      return
    }

    sendJson(response, 200, { success: true })
  } catch {
    sendJson(response, 400, { success: false, error: 'Invalid request payload' })
  }
}

const server = createServer(async (request, response) => {
  const requestUrl = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`)
  const pathname = requestUrl.pathname

  if (pathname === '/api/verify-dev-code') {
    await handleVerifyDevCode(request, response)
    return
  }

  const requestedPath = pathname === '/' ? '/index.html' : pathname
  const safePath = normalize(requestedPath).replace(/^(\.\.[/\\])+/, '')
  const filePath = join(distDir, safePath)

  if (existsSync(filePath)) {
    serveFile(response, filePath)
    return
  }

  try {
    const indexHtml = await readFile(join(distDir, 'index.html'))
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
    })
    response.end(indexHtml)
  } catch {
    response.writeHead(500, {
      'Content-Type': 'text/plain; charset=utf-8',
    })
    response.end('dist/index.html not found. Build the app before starting the server.')
  }
})

server.listen(port, () => {
  console.log(`Lumex Arcade server listening on port ${port}`)
})
