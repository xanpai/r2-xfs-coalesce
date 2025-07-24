import { IRequest, status } from 'itty-router'
import { generateSignature, decrypt } from '../utils'

export const download = async ({ headers, cf, urlHASH, query }: IRequest, env: Env, ctx: ExecutionContext) => {
    // Signature validation
    const signature = query?.sig
    if (!signature || typeof signature !== 'string') {
        return status(400)
    }

    const userIP = headers.get('CF-Connecting-IP') ||
        headers.get('x-forwarded-for')?.split(',')[0] ||
        headers.get('x-real-ip') ||
        headers.get('remote-addr') ||
        '77.96.243.165'

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
        const isR2 = url.hostname.includes('r2.cloudflarestorage.com') || url.hostname.includes('r2.dev')

        if (isB2) {
            return handleB2File(url, headers, ctx)
        } else if (isR2) {
            return handleR2File(url, headers, ctx)
        } else {
            // Fallback for any other cloud storage
            return handleCloudFile(url, headers)
        }

    } catch (error) {
        console.error('Download error:', error)
        return status(503)
    }
}

async function handleB2File(url: URL, requestHeaders: Headers, ctx: ExecutionContext): Promise<Response> {
    // B2 often has auth in URL params, so we need to be careful with caching
    const shouldCache = await shouldCacheFile(url, requestHeaders)

    if (shouldCache) {
        const cached = await getCachedResponse(url.pathname, ctx)
        if (cached) {
            return cached
        }
    }

    const fetchHeaders: Record<string, string> = {}

    // Forward important headers
    const userAgent = requestHeaders.get('User-Agent')
    if (userAgent) fetchHeaders['User-Agent'] = userAgent

    const rangeHeader = requestHeaders.get('range')
    if (rangeHeader) fetchHeaders['Range'] = rangeHeader

    const response = await fetch(url.toString(), {
        method: 'GET',
        headers: fetchHeaders
    })

    if (!response.ok) {
        return status(response.status >= 400 && response.status < 500 ? response.status : 502)
    }

    // Clone BEFORE processing the response
    let responseClone: Response | null = null
    if (shouldCache) {
        const contentLength = parseInt(response.headers.get('content-length') || '0')
        if (contentLength > 0 && contentLength < 50 * 1024 * 1024) { // < 50MB
            responseClone = response.clone()
        }
    }

    const processedResponse = processResponse(response, url)

    // Cache after processing
    if (responseClone) {
        ctx.waitUntil(cacheResponse(url.pathname, responseClone, ctx, 3600)) // 1 hour for B2
    }

    return processedResponse
}

async function handleR2File(url: URL, requestHeaders: Headers, ctx: ExecutionContext): Promise<Response> {
    // R2 is more cache-friendly since it's Cloudflare's own service
    const cached = await getCachedResponse(url.pathname, ctx)
    if (cached) {
        return cached
    }

    const fetchHeaders: Record<string, string> = {}

    const userAgent = requestHeaders.get('User-Agent')
    if (userAgent) fetchHeaders['User-Agent'] = userAgent

    const rangeHeader = requestHeaders.get('range')
    if (rangeHeader) fetchHeaders['Range'] = rangeHeader

    // R2 supports conditional requests
    const ifNoneMatch = requestHeaders.get('if-none-match')
    if (ifNoneMatch) fetchHeaders['If-None-Match'] = ifNoneMatch

    const response = await fetch(url.toString(), {
        method: 'GET',
        headers: fetchHeaders
    })

    if (!response.ok) {
        return status(response.status >= 400 && response.status < 500 ? response.status : 502)
    }

    // Clone BEFORE processing the response
    let responseClone: Response | null = null
    const contentLength = parseInt(response.headers.get('content-length') || '0')
    if (contentLength > 0 && contentLength < 100 * 1024 * 1024) { // < 100MB for R2
        responseClone = response.clone()
    }

    const processedResponse = processResponse(response, url)

    // Cache R2 files more aggressively
    if (responseClone) {
        ctx.waitUntil(cacheResponse(url.pathname, responseClone, ctx, 86400)) // 24 hours for R2
    }

    return processedResponse
}

async function handleCloudFile(url: URL, requestHeaders: Headers): Promise<Response> {
    // Generic handler for other cloud storage services
    const fetchHeaders: Record<string, string> = {}

    const userAgent = requestHeaders.get('User-Agent')
    if (userAgent) fetchHeaders['User-Agent'] = userAgent

    const rangeHeader = requestHeaders.get('range')
    if (rangeHeader) fetchHeaders['Range'] = rangeHeader

    const response = await fetch(url.toString(), {
        method: 'GET',
        headers: fetchHeaders
    })

    if (!response.ok) {
        return status(response.status >= 400 && response.status < 500 ? response.status : 502)
    }

    return processResponse(response, url)
}

function processResponse(response: Response, url: URL): Response {
    // Create a new headers object from the original response headers
    const originalHeaders = Object.fromEntries(response.headers.entries())
    const contentLength = parseInt(response.headers.get('content-length') || '0')

    // Get filename from URL path
    const filename = url.pathname.split('/').pop() || 'download'

    // Create new headers object with modifications
    const newHeaders: Record<string, string> = {
        ...originalHeaders
    }

    // Ensure proper content-disposition
    if (!newHeaders['content-disposition']?.includes('filename')) {
        newHeaders['content-disposition'] = `attachment; filename="${filename}"`
    }

    // Set appropriate cache headers based on file size
    if (contentLength > 100 * 1024 * 1024) { // > 100MB
        newHeaders['cache-control'] = 'public, max-age=3600, s-maxage=86400' // 1hr browser, 24hr CDN
    } else if (contentLength > 10 * 1024 * 1024) { // > 10MB
        newHeaders['cache-control'] = 'public, max-age=7200, s-maxage=172800' // 2hr browser, 48hr CDN
    } else {
        newHeaders['cache-control'] = 'public, max-age=31536000, immutable' // Small files
    }

    // Enable range requests for resumable downloads
    newHeaders['accept-ranges'] = 'bytes'

    // Add CORS headers if needed
    newHeaders['access-control-allow-origin'] = '*'
    newHeaders['access-control-allow-methods'] = 'GET, HEAD, OPTIONS'
    newHeaders['access-control-allow-headers'] = 'Range'

    return new Response(response.body, {
        status: response.status,
        headers: new Headers(newHeaders)
    })
}

async function shouldCacheFile(url: URL, headers: Headers): Promise<boolean> {
    // Don't cache if there's a range request (partial content)
    if (headers.get('range')) {
        return false
    }

    // Don't cache if URL has query params that look like auth tokens
    const hasAuthParams = url.search.includes('token') ||
        url.search.includes('signature') ||
        url.search.includes('expires')

    return !hasAuthParams
}

async function getCachedResponse(pathname: string, ctx: ExecutionContext): Promise<Response | null> {
    const cache = caches.default
    const hash = btoa(pathname).replace(/[^a-zA-Z0-9]/g, '')
    const cacheKey = new Request(`https://cache.movieworker.dev/v1/${hash}_v5`)

    return await cache.match(cacheKey) || null
}

async function cacheResponse(pathname: string, response: Response, ctx: ExecutionContext, maxAge: number): Promise<void> {
    const cache = caches.default
    const hash = btoa(pathname).replace(/[^a-zA-Z0-9]/g, '')
    const cacheKey = new Request(`https://cache.movieworker.dev/v1/${hash}_v5`)

    const originalHeaders = Object.fromEntries(response.headers.entries())
    const cacheResponse = new Response(response.body, {
        status: response.status,
        headers: {
            ...originalHeaders,
            'Cache-Control': `public, max-age=${maxAge}`,
            'X-Cached-At': new Date().toISOString(),
            'X-Cache-Source': 'worker'
        },
    })

    await cache.put(cacheKey, cacheResponse)
}
