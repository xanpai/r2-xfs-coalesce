/**
 * DownloadCoalescer - Durable Object for request coalescing
 *
 * When multiple users request the same file simultaneously,
 * this DO ensures only ONE request goes to B2, and the response
 * is streamed to ALL waiting clients.
 *
 * Protocol:
 * - Control messages (headers/done/error): JSON text
 * - Data chunks: Raw binary (ArrayBuffer)
 */

interface FileSession {
    url: string
    clients: Set<WebSocket>
    fetchInProgress: boolean
    fetchPromise: Promise<void> | null
    responseHeaders: Record<string, string> | null
    responseStatus: number | null
    error: string | null
}

export class DownloadCoalescer {
    private state: DurableObjectState
    private env: Env
    private sessions: Map<string, FileSession> = new Map()

    constructor(state: DurableObjectState, env: Env) {
        this.state = state
        this.env = env
    }

    async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url)

        // Check for WebSocket upgrade
        const upgradeHeader = request.headers.get('Upgrade')
        if (upgradeHeader !== 'websocket') {
            return new Response('Expected WebSocket upgrade', { status: 426 })
        }

        // Get the B2 URL from query parameter
        const b2Url = url.searchParams.get('url')
        if (!b2Url) {
            return new Response('Missing url parameter', { status: 400 })
        }

        // Get Range header if present (for partial content)
        const rangeHeader = url.searchParams.get('range') || ''

        // Create unique key for this specific request (URL + range)
        const sessionKey = `${b2Url}|${rangeHeader}`

        // Create WebSocket pair
        const webSocketPair = new WebSocketPair()
        const [client, server] = Object.values(webSocketPair)

        // Accept the WebSocket connection
        this.state.acceptWebSocket(server)

        // Store session info on the WebSocket
        ;(server as any).sessionKey = sessionKey
        ;(server as any).b2Url = b2Url
        ;(server as any).rangeHeader = rangeHeader

        // Get or create session for this URL
        let session = this.sessions.get(sessionKey)
        if (!session) {
            session = {
                url: b2Url,
                clients: new Set(),
                fetchInProgress: false,
                fetchPromise: null,
                responseHeaders: null,
                responseStatus: null,
                error: null
            }
            this.sessions.set(sessionKey, session)
        }

        // Add this client to the session
        session.clients.add(server)

        // If fetch already completed with headers, send them immediately
        if (session.responseHeaders && session.responseStatus) {
            server.send(JSON.stringify({
                type: 'headers',
                status: session.responseStatus,
                headers: session.responseHeaders
            }))
        }

        // If this is the first client, start fetching
        if (!session.fetchInProgress && !session.error) {
            session.fetchInProgress = true
            session.fetchPromise = this.fetchAndBroadcast(sessionKey, b2Url, rangeHeader)
        }

        return new Response(null, {
            status: 101,
            webSocket: client
        })
    }

    private async fetchAndBroadcast(sessionKey: string, b2Url: string, rangeHeader: string): Promise<void> {
        const session = this.sessions.get(sessionKey)
        if (!session) return

        try {
            // Build headers for B2 request
            const headers: Record<string, string> = {}
            if (rangeHeader) {
                headers['Range'] = rangeHeader
            }

            // Fetch from B2
            const response = await fetch(b2Url, { headers })

            // Store response info
            session.responseStatus = response.status
            session.responseHeaders = Object.fromEntries(response.headers.entries())

            // Broadcast headers to all clients (JSON text message)
            this.broadcastText(sessionKey, JSON.stringify({
                type: 'headers',
                status: response.status,
                headers: session.responseHeaders
            }))

            // If not successful, send error and close
            if (!response.ok && response.status !== 206) {
                const errorBody = await response.text()
                session.error = errorBody
                this.broadcastText(sessionKey, JSON.stringify({
                    type: 'error',
                    status: response.status,
                    message: errorBody.slice(0, 500) // Limit error message size
                }))
                this.closeSession(sessionKey)
                return
            }

            // Stream the response body
            const reader = response.body?.getReader()
            if (!reader) {
                this.broadcastText(sessionKey, JSON.stringify({ type: 'done' }))
                this.closeSession(sessionKey)
                return
            }

            // Read and broadcast chunks as raw binary
            while (true) {
                const { done, value } = await reader.read()

                if (done) {
                    // Signal completion with JSON text
                    this.broadcastText(sessionKey, JSON.stringify({ type: 'done' }))
                    break
                }

                if (value && value.length > 0) {
                    // Send raw binary data - no base64, no JSON
                    this.broadcastBinary(sessionKey, value)
                }
            }

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error'
            session.error = errorMessage
            this.broadcastText(sessionKey, JSON.stringify({
                type: 'error',
                status: 500,
                message: errorMessage.slice(0, 500)
            }))
        } finally {
            this.closeSession(sessionKey)
        }
    }

    private broadcastText(sessionKey: string, message: string): void {
        const session = this.sessions.get(sessionKey)
        if (!session) return

        const toRemove: WebSocket[] = []
        for (const client of session.clients) {
            try {
                client.send(message)
            } catch (e) {
                toRemove.push(client)
            }
        }

        for (const client of toRemove) {
            session.clients.delete(client)
        }
    }

    private broadcastBinary(sessionKey: string, data: Uint8Array): void {
        const session = this.sessions.get(sessionKey)
        if (!session) return

        const toRemove: WebSocket[] = []
        for (const client of session.clients) {
            try {
                // Send as ArrayBuffer (binary WebSocket message)
                client.send(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength))
            } catch (e) {
                toRemove.push(client)
            }
        }

        for (const client of toRemove) {
            session.clients.delete(client)
        }
    }

    private closeSession(sessionKey: string): void {
        const session = this.sessions.get(sessionKey)
        if (!session) return

        // Close all client connections
        for (const client of session.clients) {
            try {
                client.close(1000, 'Complete')
            } catch (e) {
                // Ignore close errors
            }
        }

        // Clean up session
        this.sessions.delete(sessionKey)
    }

    // Handle WebSocket close events
    async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
        const sessionKey = (ws as any).sessionKey
        if (sessionKey) {
            const session = this.sessions.get(sessionKey)
            if (session) {
                session.clients.delete(ws)
            }
        }
    }

    // Handle WebSocket errors
    async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
        const sessionKey = (ws as any).sessionKey
        if (sessionKey) {
            const session = this.sessions.get(sessionKey)
            if (session) {
                session.clients.delete(ws)
            }
        }
    }
}
