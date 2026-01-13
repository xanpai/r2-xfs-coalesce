/**
 * Coalesced Fetch - Uses Durable Object to deduplicate concurrent requests
 *
 * Instead of multiple requests to B2, this routes through a Durable Object
 * that ensures only one request is made to the origin, with the response
 * streamed to all waiting clients.
 */

interface CoalescedFetchOptions {
    url: string
    headers?: Headers
    env: Env
}

interface WSMessage {
    type: 'headers' | 'chunk' | 'done' | 'error'
    status?: number
    headers?: Record<string, string>
    data?: string  // base64 encoded chunk
    message?: string
}

/**
 * Performs a fetch through the coalescing Durable Object
 * Returns a Response that streams the data
 */
export async function coalescedFetch(options: CoalescedFetchOptions): Promise<Response> {
    const { url, headers, env } = options

    // Get Range header if present
    const rangeHeader = headers?.get('range') || ''

    // Create unique ID for the Durable Object based on URL
    // We use the URL path (without query params that change per request)
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
        throw new Error('Failed to establish WebSocket connection to coalescer')
    }

    // Accept the WebSocket connection
    ws.accept()

    // Create a TransformStream to convert WebSocket messages to a readable stream
    const { readable, writable } = new TransformStream()
    const writer = writable.getWriter()

    // Track response metadata
    let responseStatus: number = 200
    let responseHeaders: Headers = new Headers()
    let headersReceived = false
    let headerResolve: ((value: void) => void) | null = null
    const headersPromise = new Promise<void>((resolve) => {
        headerResolve = resolve
    })

    // Handle WebSocket messages
    ws.addEventListener('message', async (event) => {
        try {
            const message: WSMessage = JSON.parse(event.data as string)

            switch (message.type) {
                case 'headers':
                    responseStatus = message.status || 200
                    if (message.headers) {
                        responseHeaders = new Headers(message.headers)
                    }
                    headersReceived = true
                    if (headerResolve) {
                        headerResolve()
                    }
                    break

                case 'chunk':
                    if (message.data) {
                        // Decode base64 chunk
                        const binary = atob(message.data)
                        const bytes = new Uint8Array(binary.length)
                        for (let i = 0; i < binary.length; i++) {
                            bytes[i] = binary.charCodeAt(i)
                        }
                        await writer.write(bytes)
                    }
                    break

                case 'done':
                    await writer.close()
                    ws.close(1000, 'Complete')
                    break

                case 'error':
                    const error = new Error(message.message || 'Unknown error')
                    await writer.abort(error)
                    ws.close(1011, message.message || 'Error')
                    // If headers weren't received yet, we need to signal the error
                    if (!headersReceived) {
                        responseStatus = message.status || 500
                        if (headerResolve) {
                            headerResolve()
                        }
                    }
                    break
            }
        } catch (e) {
            console.error('Error processing WebSocket message:', e)
        }
    })

    ws.addEventListener('error', async (event) => {
        console.error('WebSocket error:', event)
        try {
            await writer.abort(new Error('WebSocket error'))
        } catch (e) {
            // Ignore
        }
    })

    ws.addEventListener('close', async (event) => {
        try {
            await writer.close()
        } catch (e) {
            // Already closed, ignore
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
