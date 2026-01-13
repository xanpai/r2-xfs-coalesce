/**
 * Coalesced Fetch - Uses Durable Object to deduplicate concurrent requests
 *
 * Protocol:
 * - Control messages (headers/done/error): JSON text
 * - Data chunks: Raw binary (ArrayBuffer)
 */

interface CoalescedFetchOptions {
    url: string
    headers?: Headers
    env: Env
}

interface ControlMessage {
    type: 'headers' | 'done' | 'error'
    status?: number
    headers?: Record<string, string>
    message?: string
}

/**
 * Performs a fetch through the coalescing Durable Object
 */
export async function coalescedFetch(options: CoalescedFetchOptions): Promise<Response> {
    const { url, headers, env } = options

    // Get Range header if present
    const rangeHeader = headers?.get('range') || ''

    // Create unique ID for the Durable Object based on URL
    const urlObj = new URL(url)
    const doKey = urlObj.origin + urlObj.pathname

    // Get the Durable Object stub
    const doId = env.DOWNLOAD_COALESCER.idFromName(doKey)
    const doStub = env.DOWNLOAD_COALESCER.get(doId)

    // Build the WebSocket URL with parameters
    const wsUrl = new URL('https://coalescer.internal/ws')
    wsUrl.searchParams.set('url', url)
    if (rangeHeader) {
        wsUrl.searchParams.set('range', rangeHeader)
    }

    // Upgrade to WebSocket
    const wsResponse = await doStub.fetch(wsUrl.toString(), {
        headers: {
            'Upgrade': 'websocket'
        }
    })

    // Get the WebSocket from the response
    const ws = wsResponse.webSocket
    if (!ws) {
        throw new Error('Failed to establish WebSocket connection')
    }

    // Accept the WebSocket connection
    ws.accept()

    // Create a TransformStream for the response body
    const { readable, writable } = new TransformStream()
    const writer = writable.getWriter()

    // Track response metadata
    let responseStatus: number = 200
    let responseHeaders: Headers = new Headers()
    let headersReceived = false
    let headerResolve: ((value: void) => void) | null = null
    let headerReject: ((error: Error) => void) | null = null

    const headersPromise = new Promise<void>((resolve, reject) => {
        headerResolve = resolve
        headerReject = reject
    })

    // Handle WebSocket messages
    ws.addEventListener('message', async (event) => {
        try {
            const data = event.data

            // Binary message = raw chunk data
            if (data instanceof ArrayBuffer) {
                await writer.write(new Uint8Array(data))
                return
            }

            // Text message = JSON control message
            if (typeof data === 'string') {
                const message: ControlMessage = JSON.parse(data)

                switch (message.type) {
                    case 'headers':
                        responseStatus = message.status || 200
                        if (message.headers) {
                            responseHeaders = new Headers(message.headers)
                        }
                        headersReceived = true
                        if (headerResolve) headerResolve()
                        break

                    case 'done':
                        await writer.close()
                        ws.close(1000, 'Complete')
                        break

                    case 'error':
                        if (!headersReceived) {
                            responseStatus = message.status || 500
                            if (headerResolve) headerResolve()
                        }
                        await writer.abort(new Error(message.message || 'Unknown error'))
                        ws.close(1011, 'Error')
                        break
                }
            }
        } catch (e) {
            // Silently handle errors to avoid log spam
        }
    })

    ws.addEventListener('error', async () => {
        try {
            if (!headersReceived && headerReject) {
                headerReject(new Error('WebSocket error'))
            }
            await writer.abort(new Error('WebSocket error'))
        } catch (e) {
            // Ignore
        }
    })

    ws.addEventListener('close', async () => {
        try {
            await writer.close()
        } catch (e) {
            // Already closed
        }
    })

    // Wait for headers before returning response
    await headersPromise

    return new Response(readable, {
        status: responseStatus,
        headers: responseHeaders
    })
}

/**
 * Check if a URL is a B2 URL that should use coalescing
 */
export function isB2Url(url: string): boolean {
    return url.includes('backblazeb2.com')
}
