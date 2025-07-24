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

    // For range requests, always stream directly (don't cache partial content)
    const rangeHeader = requestHeaders.get('range')
    if (rangeHeader) {
        console.log('Range request detected, streaming directly')
        return makeB2Request(url, requestHeaders)
    }

    // Check Worker cache first for smaller files (only for full file requests)
    const cacheKey = generateCacheKey(url.pathname)
    const cached = await getCachedResponse(cacheKey)
    if (cached) {
        console.log('Worker cache HIT for B2 file:', url.pathname)
        const headers = new Headers(cached.headers)
        headers.set('x-cache-status', 'worker-hit')
        return new Response(cached.body, {
            status: cached.status,
            headers
        })
    }

    // Check if there's already an active request for this file
    if (activeRequests.has(requestKey)) {
        console.log('Deduplicating B2 request for:', requestKey)
        try {
            const activeResponse = await activeRequests.get(requestKey)!
            return activeResponse.clone()
        } catch (error) {
            console.error('Error with deduplicated request:', error)
            activeRequests.delete(requestKey)
        }
    }

    // Create the request promise
    const requestPromise = makeB2RequestWithCaching(url, requestHeaders, ctx)

    // Store it for deduplication
    activeRequests.set(requestKey, requestPromise)

    // Clean up after 30 seconds
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

async function makeB2RequestWithCaching(url: URL, requestHeaders: Headers, ctx: ExecutionContext): Promise<Response> {
    const response = await makeB2Request(url, requestHeaders)

    // Only cache smaller files in Worker cache
    const contentLength = parseInt(response.headers.get('content-length') || '0')
    const MAX_WORKER_CACHE_SIZE = 400 * 1024 * 1024 // 400MB limit

    if (contentLength > 0 && contentLength <= MAX_WORKER_CACHE_SIZE) {
        console.log(`B2 file is ${Math.round(contentLength / 1024 / 1024)}MB - caching in Worker`)

        const cacheKey = generateCacheKey(url.pathname)
        const responseClone = response.clone()

        // Cache in background for 24 hours
        ctx.waitUntil(cacheB2Response(cacheKey, responseClone, 86400))
    } else {
        console.log(`B2 file is ${Math.round(contentLength / 1024 / 1024)}MB - too large for Worker cache, using CDN only`)
    }

    return response
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

        // For rate limit errors, try to serve from cache even if expired
        if (response.status === 429) {
            const cacheKey = generateCacheKey(url.pathname)
            const expiredCache = await getCachedResponse(cacheKey, true)
            if (expiredCache) {
                console.log('B2 rate limited, serving expired cache')
                const headers = new Headers(expiredCache.headers)
                headers.set('x-cache-status', 'expired-served-due-to-rate-limit')
                headers.set('x-rate-limit-source', 'backblaze-b2')
                return new Response(expiredCache.body, {
                    status: expiredCache.status,
                    headers
                })
            }

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

    const contentLength = parseInt(response.headers.get('content-length') || '0')
    return processLargeFileResponse(response, url, 'b2', contentLength)
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

function processLargeFileResponse(response: Response, url: URL, source: 'b2' | 'r2', contentLength?: number): Response {
    const originalHeaders = Object.fromEntries(response.headers.entries())
    const filename = url.pathname.split('/').pop() || 'download'
    const fileSize = contentLength || parseInt(response.headers.get('content-length') || '0')

    const newHeaders: Record<string, string> = {
        ...originalHeaders
    }

    // Ensure proper content-disposition
    if (!newHeaders['content-disposition']?.includes('filename')) {
        newHeaders['content-disposition'] = `attachment; filename="${filename}"`
    }

    const fileSizeMB = Math.round(fileSize / 1024 / 1024)
    const isSmallEnoughForWorkerCache = fileSize <= 400 * 1024 * 1024

    // Set cache strategy based on file size and source
    if (source === 'b2') {
        if (isSmallEnoughForWorkerCache) {
            // Small B2 files: Worker cache + CDN cache
            newHeaders['cache-control'] = 'public, max-age=1800, s-maxage=259200, stale-while-revalidate=86400' // 30min browser, 3 days CDN
            newHeaders['x-cache-strategy'] = 'worker+cdn-b2'
        } else {
            // Large B2 files: CDN cache only (very aggressive to reduce B2 calls)
            newHeaders['cache-control'] = 'public, max-age=300, s-maxage=2592000, stale-while-revalidate=86400' // 5min browser, 30 days CDN
            newHeaders['x-cache-strategy'] = 'cdn-aggressive-b2'
        }
    } else {
        // R2: More standard caching regardless of size
        newHeaders['cache-control'] = 'public, max-age=3600, s-maxage=604800' // 1hr browser, 7 days CDN
        newHeaders['x-cache-strategy'] = 'cdn-standard-r2'
    }

    // Essential headers for large file downloads
    newHeaders['accept-ranges'] = 'bytes'
    newHeaders['x-file-source'] = source
    newHeaders['x-file-size'] = fileSize.toString()
    newHeaders['x-worker-cacheable'] = isSmallEnoughForWorkerCache.toString()

    // Help with download managers and resumable downloads
    if (!newHeaders['etag']) {
        // Generate a simple etag based on file path and size
        newHeaders['etag'] = `"${btoa(url.pathname + fileSize).slice(0, 16)}"`
    }

    // CORS headers for browser compatibility
    newHeaders['access-control-allow-origin'] = '*'
    newHeaders['access-control-allow-methods'] = 'GET, HEAD, OPTIONS'
    newHeaders['access-control-allow-headers'] = 'Range, If-Range, If-Modified-Since'
    newHeaders['access-control-expose-headers'] = 'Content-Range, Content-Length, Accept-Ranges'

    console.log(`Serving ${source.toUpperCase()} file: ${fileSizeMB}MB (${isSmallEnoughForWorkerCache ? 'Worker+CDN' : 'CDN-only'} caching)`)

    return new Response(response.body, {
        status: response.status,
        headers: new Headers(newHeaders)
    })
}

// Clean up old active requests periodically
setInterval(() => {
    if (activeRequests.size > 100) { // Prevent memory leaks
        activeRequests.clear()
    }
}, 60000) // Clean up every minute

// Cache helper functions for smaller B2 files
function generateCacheKey(pathname: string): string {
    const hash = btoa(pathname).replace(/[^a-zA-Z0-9]/g, '')
    return `https://cache.movieworker.dev/v1/b2_${hash}_v6`
}

async function getCachedResponse(cacheKey: string, allowExpired: boolean = false): Promise<Response | null> {
    try {
        const cache = caches.default
        const request = new Request(cacheKey)
        const response = await cache.match(request)

        if (!response) return null

        // Check if cache is expired
        const cachedAt = response.headers.get('x-cached-at')
        const cacheTtl = parseInt(response.headers.get('x-cache-ttl') || '3600')

        if (cachedAt) {
            const cacheAge = (Date.now() - new Date(cachedAt).getTime()) / 1000

            if (cacheAge < cacheTtl) {
                return response // Fresh cache
            } else if (allowExpired) {
                return response // Expired but allowed
            } else {
                return null // Expired and not allowed
            }
        }

        return allowExpired ? response : null
    } catch (error) {
        console.error('Cache lookup error:', error)
        return null
    }
}

async function cacheB2Response(cacheKey: string, response: Response, maxAge: number): Promise<void> {
    try {
        const cache = caches.default
        const request = new Request(cacheKey)

        const originalHeaders = Object.fromEntries(response.headers.entries())
        const cacheResponse = new Response(response.body, {
            status: response.status,
            headers: {
                ...originalHeaders,
                'cache-control': `public, max-age=${maxAge}`,
                'x-cached-at': new Date().toISOString(),
                'x-cache-ttl': maxAge.toString(),
                'x-cache-source': 'worker-b2'
            },
        })

        await cache.put(request, cacheResponse)
        console.log('B2 file cached successfully in Worker cache')
    } catch (error) {
        console.error('Failed to cache B2 response:', error)
    }
}
