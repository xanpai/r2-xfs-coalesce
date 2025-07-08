import { IRequest, status } from 'itty-router'
import { generateSignature, decrypt } from '../utils'

export const download = async ({ headers, cf, urlHASH, query }: IRequest, env: Env, ctx: ExecutionContext) => {
    // get signature from query and check if it exists
    const signature = query?.sig
    if (!signature) {
        return status(400)
    }

    // make sure signature is a string
    if (typeof signature !== 'string') {
        return status(404)
    }

    // get user IP address
    const userIP = headers.get('CF-Connecting-IP') ||
        headers.get('x-forwarded-for')?.split(',')[0] ||
        headers.get('x-real-ip') ||
        headers.get('remote-addr') ||
        '77.96.243.165'

    // generate local signature and compare with the one from the query
    const localSignature = await generateSignature(userIP, env.SECRET)
    if (signature !== localSignature) {
        return status(405)
    }

    try {
        // decrypt the URL
        const decodedURL = await decrypt(urlHASH.replace(/-/g, '+').replace(/_/g, '/'), env.SECRET, env.IV_SECRET)
        const url = new URL(decodedURL)

        // Get range header for resume support
        const rangeHeader = headers.get('range')

        // Create cache key based on the original URL
        const cacheKey = new Request(url.toString(), { method: 'GET' })

        // Check if the full response is cached
        const cache = caches.default
        const cachedResponse = await cache.match(cacheKey)

        // Get filename from URL path
        const filename = url.pathname.split('/').pop() || 'download'

        if (cachedResponse) {
            // If we have a range request and cached full content, serve the range from cache
            if (rangeHeader) {
                return await serveRangeFromCache(cachedResponse, rangeHeader, filename)
            }

            // For full file requests, serve from cache
            const response = new Response(cachedResponse.body, {
                status: cachedResponse.status,
                headers: new Headers(cachedResponse.headers)
            })

            // Ensure proper content-disposition header
            const contentDisposition = response.headers.get('content-disposition')
            if (!contentDisposition?.includes('filename')) {
                response.headers.set('content-disposition', `attachment; filename="${filename}"`)
            }

            // Add cache hit header for debugging
            response.headers.set('X-Cache', 'HIT')
            response.headers.set('Accept-Ranges', 'bytes')

            return response
        }

        // Prepare fetch headers (including range header if present)
        const fetchHeaders = new Headers()

        // Copy relevant headers from original request
        const headersToForward = ['user-agent', 'accept', 'accept-encoding', 'accept-language']
        headersToForward.forEach(headerName => {
            const headerValue = headers.get(headerName)
            if (headerValue) {
                fetchHeaders.set(headerName, headerValue)
            }
        })

        // For cache miss, always fetch full file to cache it (ignore range header)
        // We'll serve the range from the fetched content
        const response = await fetch(url.toString(), {
            method: 'GET',
            headers: fetchHeaders
        })

        if (!response.ok) {
            return status(500)
        }

        // Clone response for caching
        const responseClone = response.clone()

        // If this was a range request, serve the range from the fetched content
        if (rangeHeader) {
            const rangeResponse = await serveRangeFromResponse(response, rangeHeader, filename)

            // Still cache the full response in background
            cacheFullResponse(cache, cacheKey, responseClone, filename, ctx)

            return rangeResponse
        }

        // For full file requests, prepare response headers
        const contentDisposition = response.headers.get('content-disposition')
        const headersObject = Object.fromEntries(response.headers.entries())

        if (!contentDisposition?.includes('filename')) {
            headersObject['content-disposition'] = `attachment; filename="${filename}"`
        }

        // Add cache control and resume support headers
        headersObject['Cache-Control'] = 'public, max-age=604800' // 1 week
        headersObject['X-Cache'] = 'MISS'
        headersObject['Accept-Ranges'] = 'bytes'

        // Create the final response
        const finalResponse = new Response(response.body, {
            status: response.status,
            headers: new Headers(headersObject)
        })

        // Cache the full response
        cacheFullResponse(cache, cacheKey, responseClone, filename, ctx)

        return finalResponse
    } catch (error) {
        console.error('Download error:', error)
        return status(503)
    }
}

// Helper function to serve range requests from cached content
async function serveRangeFromCache(cachedResponse: Response, rangeHeader: string, filename: string): Promise<Response> {
    const arrayBuffer = await cachedResponse.arrayBuffer()
    const totalLength = arrayBuffer.byteLength

    const range = parseRangeHeader(rangeHeader, totalLength)
    if (!range) {
        return new Response('Invalid range', { status: 416 })
    }

    const { start, end } = range
    const slicedBuffer = arrayBuffer.slice(start, end + 1)

    const headers = new Headers(cachedResponse.headers)
    headers.set('Content-Range', `bytes ${start}-${end}/${totalLength}`)
    headers.set('Content-Length', String(slicedBuffer.byteLength))
    headers.set('Accept-Ranges', 'bytes')
    headers.set('X-Cache', 'HIT-RANGE')

    if (!headers.get('content-disposition')?.includes('filename')) {
        headers.set('content-disposition', `attachment; filename="${filename}"`)
    }

    return new Response(slicedBuffer, {
        status: 206,
        headers
    })
}

// Helper function to serve range requests from fetched response
async function serveRangeFromResponse(response: Response, rangeHeader: string, filename: string): Promise<Response> {
    const arrayBuffer = await response.arrayBuffer()
    const totalLength = arrayBuffer.byteLength

    const range = parseRangeHeader(rangeHeader, totalLength)
    if (!range) {
        return new Response('Invalid range', { status: 416 })
    }

    const { start, end } = range
    const slicedBuffer = arrayBuffer.slice(start, end + 1)

    const headers = new Headers(response.headers)
    headers.set('Content-Range', `bytes ${start}-${end}/${totalLength}`)
    headers.set('Content-Length', String(slicedBuffer.byteLength))
    headers.set('Accept-Ranges', 'bytes')
    headers.set('X-Cache', 'MISS-RANGE')

    if (!headers.get('content-disposition')?.includes('filename')) {
        headers.set('content-disposition', `attachment; filename="${filename}"`)
    }

    return new Response(slicedBuffer, {
        status: 206,
        headers
    })
}

// Helper function to cache the full response
function cacheFullResponse(cache: Cache, cacheKey: Request, responseClone: Response, filename: string, ctx?: ExecutionContext) {
    const cacheHeaders = new Headers(responseClone.headers)
    cacheHeaders.set('Cache-Control', 'public, max-age=604800')
    cacheHeaders.set('Expires', new Date(Date.now() + 604800000).toUTCString()) // 1 week
    cacheHeaders.set('Accept-Ranges', 'bytes')

    if (!cacheHeaders.get('content-disposition')?.includes('filename')) {
        cacheHeaders.set('content-disposition', `attachment; filename="${filename}"`)
    }

    const cacheResponse = new Response(responseClone.body, {
        status: responseClone.status,
        headers: cacheHeaders
    })

    // Store in cache (don't await to avoid blocking the response)
    ctx?.waitUntil?.(cache.put(cacheKey, cacheResponse))
}

// Helper function to parse Range header
function parseRangeHeader(rangeHeader: string, totalLength: number): { start: number; end: number } | null {
    const rangeMatch = rangeHeader.match(/bytes=(\d+)-(\d*)/)
    if (!rangeMatch) return null

    const start = parseInt(rangeMatch[1], 10)
    const end = rangeMatch[2] ? parseInt(rangeMatch[2], 10) : totalLength - 1

    if (start >= totalLength || end >= totalLength || start > end) {
        return null
    }

    return { start, end }
}
