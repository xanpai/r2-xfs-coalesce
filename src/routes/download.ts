import { IRequest, status } from 'itty-router'
import { generateSignature, decrypt } from '../utils'

import { CloudflareCacheManager } from '../utils/cache-manager'

export const download = async ({ headers, cf, urlHASH, query }: IRequest, env: Env) => {
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

    // Initialize cache manager with custom options
    const cacheManager = new CloudflareCacheManager({
        maxAge: 86400 * 2, // 2 days
        staleWhileRevalidate: 3600, // 1 hour
        cacheKeyPrefix: 'dn'
    })

    try {
        // Decrypt the URL
        const decodedURL = await decrypt(urlHASH.replace(/-/g, '+').replace(/_/g, '/'), env.SECRET, env.IV_SECRET)
        const url = new URL(decodedURL)

        // Get cache stats for logging
        const cacheStats = await cacheManager.getStats(url.toString())
        console.log(url)
        console.log('Cache stats:', cacheStats)

        // Fetch with cache
        const response = await cacheManager.fetchWithCache(
            url.toString(),
            {
                method: 'GET',
                // @ts-ignore
                headers: {
                    'User-Agent': headers.get('User-Agent') || 'CF-Worker-B2-Proxy',
                    // Only forward necessary headers to B2
                    ...(headers.get('Range') && { 'Range': headers.get('Range') }),
                    ...(headers.get('If-Modified-Since') && { 'If-Modified-Since': headers.get('If-Modified-Since') }),
                    ...(headers.get('If-None-Match') && { 'If-None-Match': headers.get('If-None-Match') })
                }
            },
            {
                maxAge: 86400 * 2,  // 2 days cache
                staleWhileRevalidate: 3600, // 1 hour SWR
                customHeaders: {
                    'X-File': url.pathname.split('/').pop() || 'unknown'
                }
            }
        )

        if (!response.ok) {
            return status(500)
        }

        // Prepare final response headers
        const responseHeaders = new Headers(response.headers)
        const contentDisposition = response.headers.get('content-disposition')

        // Add filename if not present
        if (!contentDisposition?.includes('filename')) {
            const filename = url.pathname.split('/').pop()
            responseHeaders.set('content-disposition', `attachment; filename="${filename}"`)
        }

        // Add additional headers for client
        responseHeaders.set('X-Cache-Key', cacheStats.key)

        // Add CORS headers if needed
        responseHeaders.set('Access-Control-Allow-Origin', '*')
        responseHeaders.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
        responseHeaders.set('Access-Control-Allow-Headers', 'Range, If-Modified-Since, If-None-Match')

        return new Response(response.body, {
            status: response.status,
            headers: responseHeaders
        })

    } catch (error) {
        console.error('Download error:', error)
        return status(503)
    }
}
