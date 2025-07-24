import { IRequest, status } from 'itty-router'
import { generateSignature, decrypt } from '../utils'

// In-memory request deduplication to prevent multiple B2 calls for same file
const activeRequests = new Map<string, Promise<Response>>()

export const download = async ({ headers, cf, urlHASH, query }: IRequest, env: Env, ctx: ExecutionContext) => {
    // Signature validation
    const signature = query?.sig
    if (!signature || typeof signature !== 'string') {
        return status(400)
    }

    const userIP = headers.get('CF-Connecting-IP') ||
        headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
        headers.get('x-real-ip') ||
        headers.get('remote-addr')

    if (!userIP) {
        return status(400)
    }

    const localSignature = await generateSignature(userIP, env.SECRET)
    if (signature !== localSignature) {
        return status(405)
    }

    try {
        // Decrypt the URL
        const decodedURL = await decrypt(urlHASH.replace(/-/g, '+').replace(/_/g, '/'), env.SECRET, env.IV_SECRET)
        const url = new URL(decodedURL)

        // Determine if it's B2 or R2
        const isB2 = url.hostname.includes('backblazeb2.com') || url.hostname.includes('b2-api.com')

        if (isB2) {
            return handleB2LargeFile(url, headers, ctx)
        } else {
            // Treat R2 and others as more reliable
            return handleR2LargeFile(url, headers)
        }

    } catch (error) {
        console.error('Download error:', error)
        return status(503)
    }
}

async function handleB2LargeFile(url: URL, requestHeaders: Headers, ctx: ExecutionContext): Promise<Response> {
    const requestKey = `${url.pathname}_${requestHeaders.get('range') || 'full'}`
    console.log('B2 request for:', requestKey)

    // Check if there's already an active request for this file
    if (activeRequests.has(requestKey)) {
        console.log('Deduplicating B2 request for:', requestKey)
        try {
            const activeResponse = await activeRequests.get(requestKey)!
            // Clone the response since it can only be used once
            return new Response(activeResponse.body, {
                status: activeResponse.status,
                headers: new Headers(activeResponse.headers)
            })
        } catch (error) {
            console.error('Error with deduplicated request:', error)
            // Fall through to make new request
            activeRequests.delete(requestKey)
        }
    }

    // Create the request promise
    const requestPromise = makeB2Request(url, requestHeaders)

    // Store it for deduplication (but clean up after)
    activeRequests.set(requestKey, requestPromise)

    // Clean up after 30 seconds regardless
    setTimeout(() => {
        activeRequests.delete(requestKey)
    }, 30000)

    try {
        const response = await requestPromise
        return response
    } catch (error) {
        activeRequests.delete(requestKey)
        throw error
    }
}

async function makeB2Request(url: URL, requestHeaders: Headers): Promise<Response> {
    const fetchHeaders: Record<string, string> = {}

    // Forward important headers
    const userAgent = requestHeaders.get('User-Agent')
    if (userAgent) fetchHeaders['User-Agent'] = userAgent

    const rangeHeader = requestHeaders.get('range')
    if (rangeHeader) fetchHeaders['Range'] = rangeHeader

    console.log('Making B2 request to:', url.pathname, rangeHeader ? `(Range: ${rangeHeader})` : '(Full file)')

    const response = await fetch(url.toString(), {
        method: 'GET',
        headers: fetchHeaders
    })

    if (!response.ok) {
        console.error('B2 request failed:', response.status, response.statusText)

        // For rate limit errors, return a retry-after response
        if (response.status === 429) {
            return new Response('Rate limited by B2. Please try again later.', {
                status: 429,
                headers: {
                    'Retry-After': '60',
                    'X-Rate-Limit-Source': 'backblaze-b2'
                }
            })
        }

        return status(response.status >= 400 && response.status < 500 ? response.status : 502)
    }

    return processLargeFileResponse(response, url, 'b2')
}

async function handleR2LargeFile(url: URL, requestHeaders: Headers): Promise<Response> {
    const fetchHeaders: Record<string, string> = {}

    const userAgent = requestHeaders.get('User-Agent')
    if (userAgent) fetchHeaders['User-Agent'] = userAgent

    const rangeHeader = requestHeaders.get('range')
    if (rangeHeader) fetchHeaders['Range'] = rangeHeader

    console.log('Making R2 request to:', url.pathname, rangeHeader ? `(Range: ${rangeHeader})` : '(Full file)')

    const response = await fetch(url.toString(), {
        method: 'GET',
        headers: fetchHeaders
    })

    if (!response.ok) {
        return status(response.status >= 400 && response.status < 500 ? response.status : 502)
    }

    return processLargeFileResponse(response, url, 'r2')
}

function processLargeFileResponse(response: Response, url: URL, source: 'b2' | 'r2'): Response {
    const originalHeaders = Object.fromEntries(response.headers.entries())
    const filename = url.pathname.split('/').pop() || 'download'
    const contentLength = parseInt(response.headers.get('content-length') || '0')

    const newHeaders: Record<string, string> = {
        ...originalHeaders
    }

    // Ensure proper content-disposition
    if (!newHeaders['content-disposition']?.includes('filename')) {
        newHeaders['content-disposition'] = `attachment; filename="${filename}"`
    }

    // Aggressive CDN caching for large files since we can't use Worker cache
    if (source === 'b2') {
        // B2: Shorter browser cache, very long CDN cache to reduce B2 API calls
        newHeaders['cache-control'] = 'public, max-age=300, s-maxage=2592000, stale-while-revalidate=86400' // 5min browser, 30 days CDN, 1 day stale
        newHeaders['x-cache-strategy'] = 'cdn-aggressive-b2'
    } else {
        // R2: More standard caching
        newHeaders['cache-control'] = 'public, max-age=3600, s-maxage=604800' // 1hr browser, 7 days CDN
        newHeaders['x-cache-strategy'] = 'cdn-standard-r2'
    }

    // Essential headers for large file downloads
    newHeaders['accept-ranges'] = 'bytes'
    newHeaders['x-file-source'] = source
    newHeaders['x-file-size'] = contentLength.toString()

    // Help with download managers and resumable downloads
    if (!newHeaders['etag']) {
        // Generate a simple etag based on file path and size
        newHeaders['etag'] = `"${btoa(url.pathname + contentLength).slice(0, 16)}"`
    }

    // CORS headers for browser compatibility
    newHeaders['access-control-allow-origin'] = '*'
    newHeaders['access-control-allow-methods'] = 'GET, HEAD, OPTIONS'
    newHeaders['access-control-allow-headers'] = 'Range, If-Range, If-Modified-Since'
    newHeaders['access-control-expose-headers'] = 'Content-Range, Content-Length, Accept-Ranges'

    console.log(`Serving ${source.toUpperCase()} file: ${Math.round(contentLength / 1024 / 1024)}MB`)

    return new Response(response.body, {
        status: response.status,
        headers: new Headers(newHeaders)
    })
}

// Clean up old active requests periodically
setInterval(() => {
    const now = Date.now()
    for (const [key] of activeRequests) {
        // This is a simple cleanup - in production you might want more sophisticated tracking
        if (activeRequests.size > 100) { // Arbitrary limit
            activeRequests.clear()
            break
        }
    }
}, 60000) // Clean up every minute
