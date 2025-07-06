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
        '127.0.0.1'

    // generate local signature and compare with the one from the query
    const localSignature = await generateSignature(userIP, env.SECRET)
    if (signature !== localSignature) {
        return status(405)
    }

    try {
        // decrypt the URL
        const decodedURL = await decrypt(urlHASH.replace(/-/g, '+').replace(/_/g, '/'), env.SECRET, env.IV_SECRET)
        const url = new URL(decodedURL)

        // Create cache key based on the original URL
        const cacheKey = new Request(url.toString(), { method: 'GET' })

        // Check if the response is cached
        const cache = caches.default
        const cachedResponse = await caches.default.match(cacheKey)

        if (cachedResponse) {
            // Clone the cached response and add our custom headers
            const response = new Response(cachedResponse.body, {
                status: cachedResponse.status,
                headers: new Headers(cachedResponse.headers)
            })

            // Ensure proper content-disposition header
            const contentDisposition = response.headers.get('content-disposition')
            if (!contentDisposition?.includes('filename')) {
                const filename = url.pathname.split('/').pop()
                response.headers.set('content-disposition', `attachment; filename="${filename}"`)
            }

            // Add cache hit header for debugging
            response.headers.set('X-Cache', 'HIT')

            return response
        }

        // fetch the file from the URL b
        const response = await fetch(url.toString(), {
            method: 'GET',
            headers
        })

        if (!response.ok) {
            return status(500)
        }

        // Clone response for caching
        const responseClone = response.clone()

        const contentDisposition = response.headers.get('content-disposition')
        const headersObject = Object.fromEntries(response.headers.entries())

        if (!contentDisposition?.includes('filename')) {
            const filename = url.pathname.split('/').pop()
            headersObject['content-disposition'] = `attachment; filename="${filename}"`
        }

        // Add cache control headers
        headersObject['Cache-Control'] = 'public, max-age=604800' // 1 week
        headersObject['X-Cache'] = 'MISS'

        // Create the final response
        const finalResponse = new Response(response.body, {
            status: response.status,
            headers: new Headers(headersObject)
        })


        // Cache the original response (without our custom headers)
        const cacheResponse = new Response(responseClone.body, {
            status: responseClone.status,
            headers: new Headers({
                ...Object.fromEntries(responseClone.headers.entries()),
                'Cache-Control': 'public, max-age=604800',
                'Expires': new Date(Date.now() + 604800000).toUTCString() // 1 week
            })
        })

        // Store in cache (don't await to avoid blocking the response)
        ctx?.waitUntil?.(cache.put(cacheKey, cacheResponse))

        return finalResponse
    } catch (error) {
        return status(503)
    }
}
