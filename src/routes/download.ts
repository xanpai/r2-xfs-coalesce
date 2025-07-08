import { IRequest, status } from 'itty-router'
import { generateSignature, decrypt } from '../utils'

export const download = async ({ headers, cf, urlHASH, query }: IRequest, env: Env, ctx: ExecutionContext) => {
    const signature = query?.sig
    if (!signature) {
        return status(400)
    }

    if (typeof signature !== 'string') {
        return status(404)
    }

    const userIP = headers.get('CF-Connecting-IP') ||
        headers.get('x-forwarded-for')?.split(',')[0] ||
        headers.get('x-real-ip') ||
        headers.get('remote-addr') ||
        '127.0.0.1'

    const localSignature = await generateSignature(userIP, env.SECRET)
    if (signature !== localSignature) {
        return status(405)
    }

    try {
        const decodedURL = await decrypt(urlHASH.replace(/-/g, '+').replace(/_/g, '/'), env.SECRET, env.IV_SECRET)
        const url = new URL(decodedURL)

        const rangeHeader = headers.get('range')
        const cacheKey = new Request(url.toString(), { method: 'GET' })
        const cache = caches.default
        const cachedResponse = await cache.match(cacheKey)
        const filename = url.pathname.split('/').pop() || 'download'

        if (cachedResponse) {
            // serve range request from cached full file
            if (rangeHeader) {
                return await serveRangeFromCache(cachedResponse, rangeHeader, filename)
            }

            const response = new Response(cachedResponse.body, {
                status: cachedResponse.status,
                headers: new Headers(cachedResponse.headers)
            })

            const contentDisposition = response.headers.get('content-disposition')
            if (!contentDisposition?.includes('filename')) {
                response.headers.set('content-disposition', `attachment; filename="${filename}"`)
            }

            response.headers.set('X-Cache', 'HIT')
            response.headers.set('Accept-Ranges', 'bytes')

            return response
        }

        const fetchHeaders = new Headers()
        const headersToForward = ['user-agent', 'accept', 'accept-encoding', 'accept-language']
        headersToForward.forEach(headerName => {
            const headerValue = headers.get(headerName)
            if (headerValue) {
                fetchHeaders.set(headerName, headerValue)
            }
        })

        const response = await fetch(url.toString(), {
            method: 'GET',
            headers: fetchHeaders
        })

        if (!response.ok) {
            return status(500)
        }

        const responseClone = response.clone()

        if (rangeHeader) {
            // serve range from freshly fetched content and cache full file
            const rangeResponse = await serveRangeFromResponse(response, rangeHeader, filename)
            cacheFullResponse(cache, cacheKey, responseClone, filename, ctx)
            return rangeResponse
        }

        const contentDisposition = response.headers.get('content-disposition')
        const headersObject = Object.fromEntries(response.headers.entries())

        if (!contentDisposition?.includes('filename')) {
            headersObject['content-disposition'] = `attachment; filename="${filename}"`
        }

        headersObject['Cache-Control'] = 'public, max-age=604800'
        headersObject['X-Cache'] = 'MISS'
        headersObject['Accept-Ranges'] = 'bytes'

        const finalResponse = new Response(response.body, {
            status: response.status,
            headers: new Headers(headersObject)
        })

        cacheFullResponse(cache, cacheKey, responseClone, filename, ctx)

        return finalResponse
    } catch (error) {
        console.error('Download error:', error)
        return status(503)
    }
}

// serve range request from cached full file content
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

// serve range request from freshly fetched content
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

// cache full response for future requests
function cacheFullResponse(cache: Cache, cacheKey: Request, responseClone: Response, filename: string, ctx?: ExecutionContext) {
    const cacheHeaders = new Headers(responseClone.headers)
    cacheHeaders.set('Cache-Control', 'public, max-age=604800')
    cacheHeaders.set('Expires', new Date(Date.now() + 604800000).toUTCString())
    cacheHeaders.set('Accept-Ranges', 'bytes')

    if (!cacheHeaders.get('content-disposition')?.includes('filename')) {
        cacheHeaders.set('content-disposition', `attachment; filename="${filename}"`)
    }

    const cacheResponse = new Response(responseClone.body, {
        status: responseClone.status,
        headers: cacheHeaders
    })

    ctx?.waitUntil?.(cache.put(cacheKey, cacheResponse))
}

// parse range header and validate bounds
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
