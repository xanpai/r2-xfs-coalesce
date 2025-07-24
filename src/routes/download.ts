import { IRequest, status } from 'itty-router'
import { generateSignature, decrypt } from '../utils'
import { getCachedResponse, cacheB2Response, generateCacheKey } from '../utils/cache-manager'
import { cleanupActiveRequests, processLargeFileResponse } from '../utils/helpers'

// In-memory request deduplication to prevent multiple B2 calls for same file
const activeRequests = new Map<string, Promise<Response>>()

export const download = async ({ headers, cf, urlHASH, query }: IRequest, env: Env, ctx: ExecutionContext) => {
    // Clean up active requests map if it gets too large
    cleanupActiveRequests(activeRequests)

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

    // Clean up this specific request after timeout (using Promise-based cleanup)
    requestPromise.finally(() => {
        setTimeout(() => {
            activeRequests.delete(requestKey)
        }, 30000) // Clean up after 30 seconds
    })

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

    const contentLength = parseInt(response.headers.get('content-length') || '0')
    return processLargeFileResponse(response, url, 'r2', contentLength)
}
