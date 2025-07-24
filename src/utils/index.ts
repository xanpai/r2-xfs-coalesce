import { CacheManager } from './cache-manager'

/**
 * Generate a signature for the given IP address using the given secret.
 * @param ip
 * @param secret
 */
export async function generateSignature(ip: string, secret: string) {
    const encoder = new TextEncoder()

    const key = await crypto.subtle.importKey(
        'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' },
        false, ['sign']
    )

    const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(ip))
    return btoa(String.fromCharCode(...new Uint8Array(signature)))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '')
}

/**
 * Generate a key for the given secret.
 * @param secret
 */
export const getKey = async (secret: string) => {
    const keyBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))
    const truncatedKeyBuffer = keyBuffer.slice(0, 16)

    return await crypto.subtle.importKey(
        'raw',
        truncatedKeyBuffer,
        { name: 'AES-CBC' },
        false,
        ['decrypt']
    )
}

/**
 * Encrypt the given content using the given secret and iv_secret.
 * @param content
 * @param secret
 * @param iv_secret
 */
export const decrypt = async (content: string, secret: string, iv_secret: string) => {
    const key = await getKey(secret)
    const iv = new TextEncoder().encode(iv_secret).slice(0, 16)

    const decoded = Uint8Array.from(atob(content), c => c.charCodeAt(0))
    const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-CBC', iv },
        key,
        decoded
    )

    return new TextDecoder().decode(decrypted)
}

/**
 * Handle large file requests by passing through range requests and streaming the response.
 * @param url
 * @param requestHeaders
 * @param env
 */
export async function handleLargeFile(url: URL, requestHeaders: Headers, env: Env): Promise<Response> {
    // Pass through range requests for large files
    const fetchHeaders: Record<string, string> = {
        'User-Agent': requestHeaders.get('User-Agent') || ''
    }

    // Forward range header if present
    const rangeHeader = requestHeaders.get('range')
    if (rangeHeader) {
        fetchHeaders['Range'] = rangeHeader
    }

    const response = await fetch(url.toString(), {
        method: 'GET',
        headers: fetchHeaders
    })

    if (!response.ok) {
        return new Response('File not found', { status: response.status })
    }

    // Get filename from URL
    const filename = url.pathname.split('/').pop() || 'download'
    const headersObject = Object.fromEntries(response.headers.entries())

    // Ensure proper content-disposition
    if (!headersObject['content-disposition']?.includes('filename')) {
        headersObject['content-disposition'] = `attachment; filename="${filename}"`
    }

    // For large files, use shorter cache time and allow public caching
    headersObject['Cache-Control'] = 'public, max-age=3600' // 1 hour

    // Return streaming response (no memory buffering)
    return new Response(response.body, {
        status: response.status,
        headers: new Headers(headersObject)
    })
}

/**
 * Handle small file requests by caching them for 7 days and returning the response.
 * @param url
 * @param requestHeaders
 * @param ctx
 * @param env
 */
export async function handleSmallFile(url: URL, requestHeaders: Headers, ctx: ExecutionContext, env: Env): Promise<Response> {
    // Your existing cache logic for small files
    const cacheManager = new CacheManager(ctx)

    const cached = await cacheManager.get(url.pathname)
    if (cached) {
        return cached
    }

    const response = await fetch(url.toString(), {
        method: 'GET',
        headers: {
            'User-Agent': requestHeaders.get('User-Agent') || ''
        }
    })

    if (!response.ok) {
        return new Response('File not found', { status: response.status })
    }

    const headersObject = Object.fromEntries(response.headers.entries())
    const filename = url.pathname.split('/').pop() || 'download'

    if (!headersObject['content-disposition']?.includes('filename')) {
        headersObject['content-disposition'] = `attachment; filename="${filename}"`
    }

    const responseClone = response.clone()

    const finalResponse = new Response(response.body, {
        status: response.status,
        headers: new Headers({
            ...headersObject,
            'Cache-Control': 'public, max-age=31536000, immutable',
        })
    })

    // Cache small files for 7 days
    await cacheManager.set(url.pathname, responseClone, 604800)

    return finalResponse
}
