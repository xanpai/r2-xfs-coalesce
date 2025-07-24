import { IRequest, status } from 'itty-router'
import { generateSignature, decrypt } from '../utils'

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
        const isR2 = url.hostname.includes('r2.cloudflarestorage.com') || url.hostname.includes('r2.dev')

        if (isB2) {
            return handleB2File(url, headers, ctx)
        } else if (isR2) {
            return handleR2File(url, headers, ctx)
        } else {
            // Fallback - treat as B2 (more conservative caching)
            return handleB2File(url, headers, ctx)
        }

    } catch (error) {
        console.error('Download error:', error)
        return status(503)
    }
}

async function handleB2File(url: URL, requestHeaders: Headers, ctx: ExecutionContext): Promise<Response> {
    // For B2, ALWAYS try cache first to avoid rate limits
    const cacheKey = generateCacheKey(url.pathname)
    const cached = await getCachedResponse(cacheKey)
    if (cached) {
        console.log('B2 cache hit for:', url.pathname)
        return cached
    }

    console.log('B2 cache miss, fetching:', url.pathname)

    // Check if this is a range request
    const rangeHeader = requestHeaders.get('range')
    const isRangeRequest = !!rangeHeader

    // For range requests on B2, don't cache (too complex)
    if (isRangeRequest) {
        return streamB2File(url, requestHeaders)
    }

    const fetchHeaders: Record<string, string> = {}
    const userAgent = requestHeaders.get('User-Agent')
    if (userAgent) fetchHeaders['User-Agent'] = userAgent

    try {
        const response = await fetch(url.toString(), {
            method: 'GET',
            headers: fetchHeaders
        })

        if (!response.ok) {
            // If B2 returns rate limit error, return cached version even if expired
            if (response.status === 429 || response.status === 503) {
                const expiredCache = await getCachedResponse(cacheKey, true) // Allow expired
                if (expiredCache) {
                    console.log('B2 rate limited, serving expired cache')
                    return addRateLimitHeaders(expiredCache)
                }
            }
            return status(response.status >= 400 && response.status < 500 ? response.status : 502)
        }

        const contentLength = parseInt(response.headers.get('content-length') || '0')

        // Cache B2 files more aggressively to avoid rate limits
        let shouldCache = true
        let cacheTime = 86400 // 24 hours default

        if (contentLength > 500 * 1024 * 1024) { // > 500MB
            // Very large files: cache for longer but with shorter browser cache
            cacheTime = 604800 // 7 days
            shouldCache = true
        } else if (contentLength > 100 * 1024 * 1024) { // > 100MB
            cacheTime = 259200 // 3 days
            shouldCache = true
        } else {
            cacheTime = 86400 // 1 day for smaller files
            shouldCache = true
        }

        if (shouldCache) {
            // Clone before processing
            const responseClone = response.clone()
            const processedResponse = processB2Response(response, url, contentLength)

            // Cache in background
            ctx.waitUntil(cacheResponse(cacheKey, responseClone, cacheTime))

            return processedResponse
        } else {
            return processB2Response(response, url, contentLength)
        }

    } catch (error) {
        console.error('B2 fetch error:', error)
        // On any error, try to serve from cache even if expired
        const expiredCache = await getCachedResponse(cacheKey, true)
        if (expiredCache) {
            console.log('B2 error, serving expired cache')
            return addErrorHeaders(expiredCache)
        }
        return status(503)
    }
}

async function handleR2File(url: URL, requestHeaders: Headers, ctx: ExecutionContext): Promise<Response> {
    // R2 is more reliable, use lighter caching
    const cacheKey = generateCacheKey(url.pathname)
    const cached = await getCachedResponse(cacheKey)
    if (cached) {
        return cached
    }

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

    const contentLength = parseInt(response.headers.get('content-length') || '0')

    // Only cache smaller R2 files
    if (!rangeHeader && contentLength < 200 * 1024 * 1024) { // < 200MB
        const responseClone = response.clone()
        const processedResponse = processR2Response(response, url, contentLength)
        ctx.waitUntil(cacheResponse(cacheKey, responseClone, 3600)) // 1 hour
        return processedResponse
    } else {
        return processR2Response(response, url, contentLength)
    }
}

async function streamB2File(url: URL, requestHeaders: Headers): Promise<Response> {
    // Direct streaming for range requests
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
        return status(response.status)
    }

    return new Response(response.body, {
        status: response.status,
        headers: response.headers
    })
}

function processB2Response(response: Response, url: URL, contentLength: number): Response {
    const originalHeaders = Object.fromEntries(response.headers.entries())
    const filename = url.pathname.split('/').pop() || 'download'

    const newHeaders: Record<string, string> = {
        ...originalHeaders
    }

    // Ensure proper content-disposition
    if (!newHeaders['content-disposition']?.includes('filename')) {
        newHeaders['content-disposition'] = `attachment; filename="${filename}"`
    }

    // Conservative browser caching for B2, aggressive CDN caching
    if (contentLength > 100 * 1024 * 1024) { // > 100MB
        newHeaders['cache-control'] = 'public, max-age=1800, s-maxage=604800' // 30min browser, 7 days CDN
    } else {
        newHeaders['cache-control'] = 'public, max-age=3600, s-maxage=86400' // 1hr browser, 1 day CDN
    }

    newHeaders['accept-ranges'] = 'bytes'
    newHeaders['x-cache-source'] = 'b2-worker'

    return new Response(response.body, {
        status: response.status,
        headers: new Headers(newHeaders)
    })
}

function processR2Response(response: Response, url: URL, contentLength: number): Response {
    const originalHeaders = Object.fromEntries(response.headers.entries())
    const filename = url.pathname.split('/').pop() || 'download'

    const newHeaders: Record<string, string> = {
        ...originalHeaders
    }

    if (!newHeaders['content-disposition']?.includes('filename')) {
        newHeaders['content-disposition'] = `attachment; filename="${filename}"`
    }

    // More aggressive caching for R2
    newHeaders['cache-control'] = 'public, max-age=31536000, immutable'
    newHeaders['accept-ranges'] = 'bytes'
    newHeaders['x-cache-source'] = 'r2-worker'

    return new Response(response.body, {
        status: response.status,
        headers: new Headers(newHeaders)
    })
}

function generateCacheKey(pathname: string): string {
    const hash = btoa(pathname).replace(/[^a-zA-Z0-9]/g, '')
    return `https://cache.movieworker.dev/v1/b2_${hash}_v5`
}

async function getCachedResponse(cacheKey: string, allowExpired: boolean = false): Promise<Response | null> {
    const cache = caches.default
    const request = new Request(cacheKey)
    const response = await cache.match(request)

    if (!response) return null

    if (!allowExpired) return response

    // For expired cache, check if it's still usable
    const cacheControl = response.headers.get('cache-control')
    if (cacheControl && cacheControl.includes('max-age')) {
        const cachedAt = response.headers.get('x-cached-at')
        if (cachedAt) {
            const cacheAge = Date.now() - new Date(cachedAt).getTime()
            // Allow serving cache up to 7 days old in emergency
            if (cacheAge < 7 * 24 * 60 * 60 * 1000) {
                return response
            }
        }
    }

    return response // Return anyway if no timestamp
}

async function cacheResponse(cacheKey: string, response: Response, maxAge: number): Promise<void> {
    const cache = caches.default
    const request = new Request(cacheKey)

    const originalHeaders = Object.fromEntries(response.headers.entries())
    const cacheResponse = new Response(response.body, {
        status: response.status,
        headers: {
            ...originalHeaders,
            'cache-control': `public, max-age=${maxAge}`,
            'x-cached-at': new Date().toISOString(),
            'x-cache-ttl': maxAge.toString()
        },
    })

    await cache.put(request, cacheResponse)
}

function addRateLimitHeaders(response: Response): Response {
    const headers = new Headers(response.headers)
    headers.set('x-served-from', 'cache-rate-limit')
    headers.set('x-cache-status', 'expired-but-served')

    return new Response(response.body, {
        status: response.status,
        headers
    })
}

function addErrorHeaders(response: Response): Response {
    const headers = new Headers(response.headers)
    headers.set('x-served-from', 'cache-error-fallback')
    headers.set('x-cache-status', 'expired-but-served')

    return new Response(response.body, {
        status: response.status,
        headers
    })
}
